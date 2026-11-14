import { drive, type drive_v2, type drive_v3, type MethodOptions } from '@googleapis/drive';
import { OAuth2Client } from 'google-auth-library';
import type { CredentialProvider, GoogleOAuthCredentials } from '../../credentials/types.js';
import {
  CredentialError,
  FoundationError,
  type MessagePart,
  ProviderApiError,
  providerText,
} from '../../errors.js';
import { googleErrorInfo, RATE_LIMIT_REASONS } from '../google/errors.js';

/**
 * OAuth scopes requested by `npm run auth:google -- --drive`. `drive` can manage every file in the
 * user's Drive: it is needed because the vault holds files created by Drive for desktop and by hand,
 * which `drive.file` cannot reach. The connector itself only reads and writes the configured folders.
 */
export const GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DRIVE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
/** Google Docs, Sheets, … (and folders, shortcuts): no Markdown bytes behind them. */
export const isGoogleAppsType = (mimeType: string) => mimeType.startsWith('application/vnd.google-apps.');

/** MIME type of files AI Foundation creates. Existing files keep theirs (Drive for desktop uses text/plain). */
const MARKDOWN_MIME = 'text/markdown';

/** An item in a folder: a file, a folder or a shortcut. */
export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  /** RFC 3339. */
  modifiedTime: string;
}

/**
 * What an append is based on: the etag and head revision of one v2 files.get, so that the content
 * read (that revision) and the precondition of the write (that etag) are the same version. The etag
 * is opaque: never parsed or built.
 */
export interface DriveRevision {
  fileId: string;
  etag: string;
  headRevisionId: string;
  mimeType: string;
  /** Where the file is at that version: callers check it is still the path they resolved. */
  name: string;
  parentIds: string[];
  trashed: boolean;
}

/** A conditional update was refused (HTTP 412): the file changed after its revision was read. Nothing was written. */
export class StaleRevisionError extends Error {
  override name = 'StaleRevisionError';
}

/**
 * The Drive calls the vault storages use, with pagination done. Methods throw what the SDK throws
 * (convert with `toDriveError`), except `updateContent`'s StaleRevisionError. Tests inject a fake.
 */
export interface DriveApi {
  getItem(fileId: string): Promise<DriveItem>;
  /**
   * Untrashed children of the folder, every page. With `name`, only items of that name — Drive
   * compares names case-insensitively, so callers check the exact name themselves.
   */
  listChildren(folderId: string, options?: { name?: string }): Promise<DriveItem[]>;
  /** The current content. */
  download(fileId: string): Promise<Buffer>;
  revisionOf(fileId: string): Promise<DriveRevision>;
  /** The content of exactly that revision, even when the file changed since. */
  downloadRevision(revision: DriveRevision): Promise<Buffer>;
  /** A new file (never replaces one); Drive allows several with one name. */
  createFile(parentId: string, name: string, text: string): Promise<DriveItem>;
  /** Replaces the content when the file is still at `revision`; StaleRevisionError otherwise. Updates the modified time. */
  updateContent(revision: DriveRevision, bytes: Buffer): Promise<void>;
}

export type DriveApiFactory = (credentials: GoogleOAuthCredentials) => DriveApi;

/** The googleapis methods `driveApiFrom` uses. Tests fake these to check request parameters. */
export interface DriveResources {
  v3: {
    files: {
      get(params: drive_v3.Params$Resource$Files$Get, options?: MethodOptions): Promise<{ data: unknown }>;
      list(params: drive_v3.Params$Resource$Files$List, options?: MethodOptions): Promise<{ data: drive_v3.Schema$FileList }>;
      create(params: drive_v3.Params$Resource$Files$Create, options?: MethodOptions): Promise<{ data: drive_v3.Schema$File }>;
    };
    revisions: {
      get(params: drive_v3.Params$Resource$Revisions$Get, options?: MethodOptions): Promise<{ data: unknown }>;
    };
  };
  v2: {
    files: {
      get(params: drive_v2.Params$Resource$Files$Get, options?: MethodOptions): Promise<{ data: drive_v2.Schema$File }>;
      update(params: drive_v2.Params$Resource$Files$Update, options?: MethodOptions): Promise<{ data: drive_v2.Schema$File }>;
    };
  };
}

const ITEM_FIELDS = 'id,name,mimeType,trashed,modifiedTime';
/** v2 names: `title` is the name, `labels.trashed` the trash state. One response, one version. */
const REVISION_FIELDS = 'etag,headRevisionId,mimeType,title,parents(id),labels(trashed)';
const PAGE_SIZE = 1000;
/** Writes are sent once: a write whose result is unknown is never repeated (reads keep the SDK's retries). */
const WRITE_OPTIONS = { retry: false } as const;
const BINARY = { responseType: 'arraybuffer' } as const;

/** A Drive query string literal: `\` and `'` escaped. */
export function driveQueryString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function toItem(file: drive_v3.Schema$File): DriveItem {
  if (!file.id || file.name == null || !file.mimeType) {
    throw new ProviderApiError('Google Drive', 'returned an item without an id, name or MIME type');
  }
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    trashed: file.trashed ?? false,
    modifiedTime: file.modifiedTime ?? new Date(0).toISOString(),
  };
}

const toBuffer = (data: unknown) => Buffer.from(data as ArrayBuffer);

/** Builds the storage-facing API, with pagination, on top of the googleapis clients. */
export function driveApiFrom(api: DriveResources): DriveApi {
  return {
    async getItem(fileId) {
      const { data } = await api.v3.files.get({ fileId, fields: ITEM_FIELDS });
      return toItem(data as drive_v3.Schema$File);
    },

    async listChildren(folderId, { name } = {}) {
      const q = [`${driveQueryString(folderId)} in parents`, 'trashed = false'];
      if (name !== undefined) q.push(`name = ${driveQueryString(name)}`);
      const items: DriveItem[] = [];
      let pageToken: string | undefined;
      do {
        const { data } = await api.v3.files.list({
          q: q.join(' and '),
          fields: `nextPageToken,files(${ITEM_FIELDS})`,
          pageSize: PAGE_SIZE,
          spaces: 'drive',
          pageToken,
        });
        items.push(...(data.files ?? []).map(toItem));
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
      return items;
    },

    async download(fileId) {
      return toBuffer((await api.v3.files.get({ fileId, alt: 'media' }, BINARY)).data);
    },

    async revisionOf(fileId) {
      const { data } = await api.v2.files.get({ fileId, fields: REVISION_FIELDS });
      if (!data.etag || !data.headRevisionId || data.title == null) {
        throw new ProviderApiError('Google Drive', 'returned no revision for a file to append to');
      }
      return {
        fileId,
        etag: data.etag,
        headRevisionId: data.headRevisionId,
        mimeType: data.mimeType || MARKDOWN_MIME,
        name: data.title,
        parentIds: (data.parents ?? []).flatMap((parent) => (parent.id ? [parent.id] : [])),
        trashed: data.labels?.trashed ?? false,
      };
    },

    async downloadRevision({ fileId, headRevisionId }) {
      return toBuffer((await api.v3.revisions.get({ fileId, revisionId: headRevisionId, alt: 'media' }, BINARY)).data);
    },

    async createFile(parentId, name, text) {
      const { data } = await api.v3.files.create(
        {
          requestBody: { name, parents: [parentId], mimeType: MARKDOWN_MIME },
          media: { mimeType: MARKDOWN_MIME, body: text },
          fields: ITEM_FIELDS,
        },
        WRITE_OPTIONS,
      );
      return toItem(data);
    },

    async updateContent({ fileId, etag, mimeType }, bytes) {
      try {
        // v2: the only Drive API whose etag a conditional update can use. Media only: name,
        // parents and MIME type stay as they are, and the modified time is updated as usual.
        await api.v2.files.update(
          { fileId, media: { mimeType, body: bytes }, fields: 'etag' },
          { ...WRITE_OPTIONS, headers: { 'If-Match': etag } },
        );
      } catch (error) {
        if (googleErrorInfo(error).status === 412) throw new StaleRevisionError('precondition failed', { cause: error });
        throw error;
      }
    },
  };
}

export const createDriveApi: DriveApiFactory = ({ clientId, clientSecret, refreshToken }) => {
  const auth = new OAuth2Client({ clientId, clientSecret });
  auth.setCredentials({ refresh_token: refreshToken });
  return driveApiFrom({
    v3: drive({ version: 'v3', auth }),
    v2: drive({ version: 'v2', auth }),
  } as unknown as DriveResources);
};

/** Creates the API client on first use, so the server starts without credentials. */
export function lazyDriveApi(
  credentials: CredentialProvider,
  factory: DriveApiFactory = createDriveApi,
): () => Promise<DriveApi> {
  let api: Promise<DriveApi> | undefined;
  return () => {
    api ??= credentials.getGoogleOAuthCredentials().then(factory);
    api.catch(() => (api = undefined));
    return api;
  };
}

/** 403 reasons meaning "these credentials may not use Drive at all": the scope or the API is missing. */
const NOT_GRANTED_REASONS = new Set(['insufficientPermissions', 'accessNotConfigured', 'SERVICE_DISABLED']);
/** 403 / 429 reasons meaning "slow down", beyond the ones every Google API uses. */
const DRIVE_RATE_LIMIT_REASONS = new Set([...RATE_LIMIT_REASONS, 'dailyLimitExceeded', 'sharingRateLimitExceeded']);

export interface DriveErrorOptions {
  /** The error for a 404 (otherwise a provider error). */
  notFound?: () => FoundationError;
  /** Prefixes the provider error, e.g. which file failed. Never an ID or a token. */
  context?: string;
  /**
   * For a write: the message when its result is unknown (no response, or a 5xx). The SDK's text is
   * appended as provider text.
   */
  unknownResult?: string;
}

/** Converts anything thrown by the Drive client into a Foundation error. Messages never carry IDs or tokens. */
export function toDriveError(error: unknown, { notFound, context, unknownResult }: DriveErrorOptions = {}): FoundationError {
  if (error instanceof FoundationError) return error;
  const { status, reasons, message, invalidGrant } = googleErrorInfo(error);
  const options = { cause: error };
  const prefixed = (parts: MessagePart[]): MessagePart[] => (context ? [`${context}: `, ...parts] : parts);

  if (invalidGrant) {
    return new CredentialError(
      'Google rejected the refresh token (invalid_grant); run `npm run auth:google -- --drive` and update GOOGLE_OAUTH_REFRESH_TOKEN',
      options,
    );
  }
  if (status === 401) {
    return new CredentialError(['Google rejected the credentials (HTTP 401): ', providerText(message)], options);
  }
  if (status === 403 && (reasons.some((r) => NOT_GRANTED_REASONS.has(r)) || /insufficient authentication scopes/i.test(message))) {
    return new CredentialError(
      [
        'Google Drive access is not granted (HTTP 403); enable the Google Drive API and run `npm run auth:google -- --drive`: ',
        providerText(message),
      ],
      options,
    );
  }
  if ((status === 403 || status === 429) && (status === 429 || reasons.some((r) => DRIVE_RATE_LIMIT_REASONS.has(r)))) {
    return new ProviderApiError('Google Drive', prefixed([`rate limit exceeded (HTTP ${status}); try again later`]), options);
  }
  if (status === 403 && reasons.includes('insufficientFilePermissions')) {
    return new ProviderApiError('Google Drive', prefixed(['no permission for this file in Google Drive (HTTP 403)']), options);
  }
  if (status === 403) {
    return new CredentialError(['Google denied access (HTTP 403): ', providerText(message)], options);
  }
  if (status === 404 && notFound) return notFound();
  if (unknownResult && (status === undefined || status >= 500)) {
    return new ProviderApiError('Google Drive', [unknownResult, ' (', providerText(message), ')'], options);
  }
  return new ProviderApiError('Google Drive', prefixed([...(status ? [`HTTP ${status}: `] : []), providerText(message)]), options);
}
