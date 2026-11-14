import { describe, expect, it } from 'vitest';
import {
  type DriveResources,
  driveApiFrom,
  driveQueryString,
  GOOGLE_DRIVE_SCOPES,
  lazyDriveApi,
  StaleRevisionError,
  toDriveError,
} from '../../../src/connectors/google-drive/client.js';
import type { CredentialProvider } from '../../../src/credentials/types.js';
import {
  ConfigurationError,
  CredentialError,
  MissingCredentialError,
  NotFoundError,
  PROVIDER_TEXT_OMITTED,
  ProviderApiError,
} from '../../../src/errors.js';
import { googleError } from './fake-drive.js';

interface Request {
  method: string;
  params: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

/** Fake googleapis resources: records every request and serves list pages keyed by pageToken. */
function fakeResources({ pages = [[]], fail }: { pages?: unknown[][]; fail?: Partial<Record<string, unknown>> } = {}) {
  const requests: Request[] = [];
  const handle = (method: string, data: (params: Record<string, unknown>) => unknown) => {
    return async (params: Record<string, unknown>, options?: Record<string, unknown>) => {
      requests.push({ method, params, options });
      if (fail?.[method]) throw fail[method];
      return { data: data(params) };
    };
  };
  const file = { id: 'file-1', name: 'a.md', mimeType: 'text/plain', trashed: false, modifiedTime: '2026-11-14T00:00:00.000Z' };
  const resources = {
    v3: {
      files: {
        get: handle('v3.files.get', (params) => (params.alt === 'media' ? new TextEncoder().encode('本文').buffer : file)),
        list: handle('v3.files.list', (params) => {
          const index = Number(params.pageToken ?? 0);
          return { files: pages[index] ?? [], nextPageToken: index + 1 < pages.length ? String(index + 1) : undefined };
        }),
        create: handle('v3.files.create', (params) => ({ ...file, id: 'new-1', name: (params.requestBody as { name: string }).name })),
      },
      revisions: { get: handle('v3.revisions.get', () => new TextEncoder().encode('版の本文').buffer) },
    },
    v2: {
      files: {
        get: handle('v2.files.get', () => ({
          etag: '"etag-1"',
          headRevisionId: 'rev-1',
          mimeType: 'text/plain',
          title: 'a.md',
          parents: [{ id: 'folder-1' }],
          labels: { trashed: false },
        })),
        update: handle('v2.files.update', () => ({ etag: '"etag-2"' })),
      },
    },
  } as unknown as DriveResources;
  return { api: driveApiFrom(resources), requests };
}

const PLACE = { name: 'a.md', parentIds: ['folder-1'], trashed: false };
const item = (id: string, name: string) => ({ id, name, mimeType: 'text/plain', trashed: false, modifiedTime: '2026-11-14T00:00:00.000Z' });

describe('GOOGLE_DRIVE_SCOPES', () => {
  it('is the full Drive scope (files made by Drive for desktop are out of reach of drive.file)', () => {
    expect(GOOGLE_DRIVE_SCOPES).toEqual(['https://www.googleapis.com/auth/drive']);
  });
});

describe('driveQueryString', () => {
  it("escapes backslashes and single quotes", () => {
    expect(driveQueryString("it's")).toBe("'it\\'s'");
    expect(driveQueryString('a\\b')).toBe("'a\\\\b'");
    expect(driveQueryString("\\'")).toBe("'\\\\\\''");
  });
});

describe('listChildren', () => {
  it('lists untrashed children of the folder, every page', async () => {
    const { api, requests } = fakeResources({ pages: [[item('1', 'a.md')], [item('2', 'b.md')], [item('3', 'c')]] });
    const children = await api.listChildren('folder-1');
    expect(children.map((c) => c.name)).toEqual(['a.md', 'b.md', 'c']);
    expect(requests.map((r) => r.params.pageToken)).toEqual([undefined, '1', '2']);
    expect(requests[0]!.params).toMatchObject({
      q: "'folder-1' in parents and trashed = false",
      pageSize: 1000,
      spaces: 'drive',
      fields: 'nextPageToken,files(id,name,mimeType,trashed,modifiedTime)',
    });
  });

  it('adds an escaped name condition', async () => {
    const { api, requests } = fakeResources();
    await api.listChildren('folder-1', { name: "メモ it's \\.md" });
    expect(requests[0]!.params.q).toBe("'folder-1' in parents and trashed = false and name = 'メモ it\\'s \\\\.md'");
  });
});

describe('reading', () => {
  it('reads an item with only the fields it needs', async () => {
    const { api, requests } = fakeResources();
    expect(await api.getItem('file-1')).toEqual(item('file-1', 'a.md'));
    expect(requests[0]!.params).toEqual({ fileId: 'file-1', fields: 'id,name,mimeType,trashed,modifiedTime' });
  });

  it('downloads the current content as bytes', async () => {
    const { api, requests } = fakeResources();
    expect((await api.download('file-1')).toString('utf8')).toBe('本文');
    expect(requests[0]).toMatchObject({ method: 'v3.files.get', params: { fileId: 'file-1', alt: 'media' } });
    expect(requests[0]!.options).toMatchObject({ responseType: 'arraybuffer' });
  });

  it('reads the etag, head revision and place of the file from one v2 files.get, and downloads that revision', async () => {
    const { api, requests } = fakeResources();
    const revision = await api.revisionOf('file-1');
    expect(revision).toEqual({
      fileId: 'file-1',
      etag: '"etag-1"',
      headRevisionId: 'rev-1',
      mimeType: 'text/plain',
      name: 'a.md',
      parentIds: ['folder-1'],
      trashed: false,
    });
    expect(requests[0]).toMatchObject({
      method: 'v2.files.get',
      params: { fileId: 'file-1', fields: 'etag,headRevisionId,mimeType,title,parents(id),labels(trashed)' },
    });
    expect((await api.downloadRevision(revision)).toString('utf8')).toBe('版の本文');
    expect(requests[1]).toMatchObject({
      method: 'v3.revisions.get',
      params: { fileId: 'file-1', revisionId: 'rev-1', alt: 'media' },
      options: { responseType: 'arraybuffer' },
    });
  });
});

describe('writing', () => {
  it('creates a Markdown file in the folder, sent once', async () => {
    const { api, requests } = fakeResources();
    const created = await api.createFile('folder-1', '新規.md', '本文\n');
    expect(created.name).toBe('新規.md');
    expect(requests[0]).toMatchObject({
      method: 'v3.files.create',
      params: {
        requestBody: { name: '新規.md', parents: ['folder-1'], mimeType: 'text/markdown' },
        media: { mimeType: 'text/markdown', body: '本文\n' },
      },
      options: { retry: false },
    });
  });

  it('updates the content conditionally on the etag, keeping the MIME type and the usual modified time', async () => {
    const { api, requests } = fakeResources();
    const bytes = Buffer.from([0x61, 0xff, 0x0a]);
    await api.updateContent({ fileId: 'file-1', etag: '"etag-1"', headRevisionId: 'rev-1', mimeType: 'text/plain', ...PLACE }, bytes);
    const [request] = requests;
    expect(request).toMatchObject({ method: 'v2.files.update', params: { fileId: 'file-1', media: { mimeType: 'text/plain' } } });
    expect((request!.params.media as { body: Buffer }).body).toBe(bytes);
    expect(request!.options).toEqual({ retry: false, headers: { 'If-Match': '"etag-1"' } });
    // Nothing that would keep the modified date (and so the etag) as it was.
    expect(request!.params).not.toHaveProperty('modifiedDateBehavior');
    expect(request!.params).not.toHaveProperty('setModifiedDate');
    expect(request!.params).not.toHaveProperty('requestBody');
  });

  it('reports a failed precondition as StaleRevisionError and passes other errors on', async () => {
    const revision = { fileId: 'file-1', etag: '"old"', headRevisionId: 'rev-1', mimeType: 'text/plain', ...PLACE };
    const stale = fakeResources({ fail: { 'v2.files.update': googleError(412, 'conditionNotMet') } });
    await expect(stale.api.updateContent(revision, Buffer.from('x'))).rejects.toBeInstanceOf(StaleRevisionError);
    const failure = googleError(500);
    const broken = fakeResources({ fail: { 'v2.files.update': failure } });
    await expect(broken.api.updateContent(revision, Buffer.from('x'))).rejects.toBe(failure);
  });
});

describe('lazyDriveApi', () => {
  const credentials = (fail = false): CredentialProvider & { calls: number } => {
    const provider = {
      calls: 0,
      async getGoogleOAuthCredentials() {
        provider.calls += 1;
        if (fail) throw new MissingCredentialError('Google credential is not configured: set GOOGLE_OAUTH_REFRESH_TOKEN');
        return { clientId: 'id', clientSecret: 'secret', refreshToken: 'token' };
      },
    } as unknown as CredentialProvider & { calls: number };
    return provider;
  };

  it('creates the client once, on first use', async () => {
    const provider = credentials();
    let made = 0;
    const lazy = lazyDriveApi(provider, () => {
      made += 1;
      return fakeResources().api;
    });
    expect(provider.calls).toBe(0);
    await Promise.all([lazy(), lazy()]);
    expect(made).toBe(1);
  });

  it('tries again after a credential error', async () => {
    const provider = credentials(true);
    const lazy = lazyDriveApi(provider, () => fakeResources().api);
    await expect(lazy()).rejects.toBeInstanceOf(MissingCredentialError);
    await expect(lazy()).rejects.toBeInstanceOf(MissingCredentialError);
    expect(provider.calls).toBe(2);
  });
});

describe('toDriveError', () => {
  const SECRET = 'SECRET-sdk-text-ya29.token';

  it.each([
    ['invalid_grant', Object.assign(new Error(`invalid_grant ${SECRET}`), {}), CredentialError, '`npm run auth:google -- --drive`'],
    ['401', googleError(401, 'authError', SECRET), CredentialError, 'Google rejected the credentials (HTTP 401)'],
    ['scope missing', googleError(403, 'insufficientPermissions', SECRET), CredentialError, 'Google Drive access is not granted'],
    ['API disabled', googleError(403, 'accessNotConfigured', SECRET), CredentialError, 'enable the Google Drive API'],
    ['file permission', googleError(403, 'insufficientFilePermissions', SECRET), ProviderApiError, 'no permission for this file'],
    ['rate limit 403', googleError(403, 'userRateLimitExceeded', SECRET), ProviderApiError, 'rate limit exceeded (HTTP 403)'],
    ['rate limit 429', googleError(429, 'rateLimitExceeded', SECRET), ProviderApiError, 'rate limit exceeded (HTTP 429)'],
    ['other 403', googleError(403, 'forbidden', SECRET), CredentialError, 'Google denied access (HTTP 403)'],
    ['500', googleError(500, undefined, SECRET), ProviderApiError, 'HTTP 500'],
  ])('classifies %s', (_label, error, type, text) => {
    const converted = toDriveError(error);
    expect(converted).toBeInstanceOf(type);
    expect(converted.publicMessage).toContain(text);
    expect(converted.publicMessage).not.toContain(SECRET);
    expect(converted.cause).toBe(error);
  });

  it('keeps the SDK text in the MCP message only', () => {
    const converted = toDriveError(googleError(500, undefined, SECRET), { context: 'cannot read "obsidian:K/a.md"' });
    expect(converted.message).toBe(`Google Drive API error: cannot read "obsidian:K/a.md": HTTP 500: ${SECRET}`);
    expect(converted.publicMessage).toBe(`Google Drive API error: cannot read "obsidian:K/a.md": HTTP 500: ${PROVIDER_TEXT_OMITTED}`);
  });

  it('uses notFound for a 404', () => {
    const converted = toDriveError(googleError(404, 'notFound'), { notFound: () => new NotFoundError('gone') });
    expect(converted).toBeInstanceOf(NotFoundError);
    expect(toDriveError(googleError(404, 'notFound'))).toBeInstanceOf(ProviderApiError);
  });

  it('says a write may or may not have happened when there was no answer or a 5xx', () => {
    for (const error of [googleError(undefined, undefined, SECRET), googleError(503, undefined, SECRET)]) {
      const converted = toDriveError(error, { unknownResult: 'could not confirm whether "obsidian:K/a.md" was created' });
      expect(converted).toBeInstanceOf(ProviderApiError);
      expect(converted.publicMessage).toBe(
        `Google Drive API error: could not confirm whether "obsidian:K/a.md" was created (${PROVIDER_TEXT_OMITTED})`,
      );
    }
    // A 4xx is an answer: the write did not happen.
    expect(toDriveError(googleError(400), { unknownResult: 'x' }).publicMessage).not.toContain('x (');
  });

  it('passes Foundation errors through', () => {
    const error = new ConfigurationError('sources.knowledge.obsidian.vault_folder_id is not set');
    expect(toDriveError(error)).toBe(error);
  });
});
