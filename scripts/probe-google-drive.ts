/**
 * Verification probes for Google Drive storage (docs/plans/google-drive-storage-implementation-plan.md §4).
 * Separate from the implementation: nothing in src/ imports this file, and `npm test` does not run it.
 *
 *   npx tsx scripts/probe-google-drive.ts <p01|p02|p03> [--keep] [--manual]
 *
 * Needs GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN (with the
 * Drive scope: `npm run auth:google -- --drive`) and GOOGLE_DRIVE_PROBE_FOLDER_ID, a folder in My
 * Drive whose name starts with "AI Foundation Probe". GOOGLE_DRIVE_VAULT_FOLDER_ID is optional and
 * only ever read with one files.get (P-01 step 10).
 *
 * Safety: only files this run creates (named `probe-<runId>-…`) are written; other files in the
 * probe folder are only read. At the end the created files are moved to the trash (never deleted)
 * unless --keep is given. Every request is sent with `retry: false`, so each result is one request.
 *
 * Output: JSON Lines on stdout (the evidence), progress on stderr. Access and refresh tokens, the
 * Authorization header and request configs are never printed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { calendar } from '@googleapis/calendar';
import { drive, type drive_v2, type drive_v3 } from '@googleapis/drive';
import { OAuth2Client } from 'google-auth-library';

const PROBE_FOLDER_PREFIX = 'AI Foundation Probe';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MARKDOWN_MIME = 'text/markdown';
const FILE_FIELDS =
  'id,name,mimeType,trashed,parents,size,modifiedTime,createdTime,headRevisionId,version,md5Checksum,driveId,ownedByMe';
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;
/** Per-request options: one request per call, so the probe sees each status as Google sent it. */
const NO_RETRY = { retry: false } as const;

// ---------------------------------------------------------------------------------------------
// Arguments and environment

function fail(message: string): never {
  console.error(`[probe:drive] ${message}`);
  process.exit(1);
}

const USAGE = 'Usage: npx tsx scripts/probe-google-drive.ts <p01|p02|p03> [--keep] [--manual]';
let parsed: ReturnType<typeof parseArguments>;
function parseArguments() {
  return parseArgs({
    options: { keep: { type: 'boolean', default: false }, manual: { type: 'boolean', default: false } },
    allowPositionals: true,
    strict: true,
  });
}
try {
  parsed = parseArguments();
} catch (error) {
  fail(`${error instanceof Error ? error.message : String(error)}. ${USAGE}`);
}
const probe = parsed.positionals[0];
if (parsed.positionals.length !== 1 || (probe !== 'p01' && probe !== 'p02' && probe !== 'p03')) fail(USAGE);
const { keep, manual } = parsed.values;

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = (name: string) => process.env[name]?.trim() || undefined;
const clientId = env('GOOGLE_OAUTH_CLIENT_ID');
const clientSecret = env('GOOGLE_OAUTH_CLIENT_SECRET');
const refreshToken = env('GOOGLE_OAUTH_REFRESH_TOKEN');
const probeFolderId = env('GOOGLE_DRIVE_PROBE_FOLDER_ID');
const vaultFolderId = env('GOOGLE_DRIVE_VAULT_FOLDER_ID');
if (!clientId || !clientSecret || !refreshToken) {
  fail('Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REFRESH_TOKEN first.');
}
if (!probeFolderId) fail(`Set GOOGLE_DRIVE_PROBE_FOLDER_ID to a folder whose name starts with "${PROBE_FOLDER_PREFIX}".`);

const runId = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;

// ---------------------------------------------------------------------------------------------
// Evidence

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

function record(step: string, data: Record<string, Json>): void {
  console.log(JSON.stringify({ probe, runId, step, at: new Date().toISOString(), ...data }));
}

function progress(message: string): void {
  console.error(`[probe:drive] ${message}`);
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** The parts of a Drive file worth keeping as evidence. */
function fileFacts(file: drive_v3.Schema$File | undefined): Record<string, Json> {
  if (!file) return {};
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    trashed: file.trashed,
    size: file.size,
    version: file.version,
    headRevisionId: file.headRevisionId,
    md5Checksum: file.md5Checksum,
    modifiedTime: file.modifiedTime,
    createdTime: file.createdTime,
    driveId: file.driveId,
    ownedByMe: file.ownedByMe,
  };
}

interface ErrorFacts {
  status: number | undefined;
  reasons: string[];
  message: string;
}

/** Status, Google's reasons and message of a failed request — never its config (it holds the token). */
function errorFacts(error: unknown): ErrorFacts {
  const e = error as { status?: number; response?: { status?: number; data?: unknown }; message?: string };
  const data = e.response?.data as { error?: { errors?: { reason?: string }[]; message?: string } } | undefined;
  return {
    status: e.status ?? e.response?.status,
    reasons: (data?.error?.errors ?? []).map((item) => item.reason ?? ''),
    message: data?.error?.message ?? e.message ?? String(error),
  };
}

function etagOf(headers: unknown): string | undefined {
  if (headers instanceof Headers) return headers.get('etag') ?? undefined;
  const value = (headers as Record<string, unknown> | undefined)?.etag;
  return typeof value === 'string' ? value : undefined;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ErrorFacts };

/** Runs one request and records its outcome. `facts` picks what to keep from a success. */
async function attempt<T>(
  step: string,
  request: Record<string, Json>,
  run: () => Promise<T>,
  facts: (value: T) => Record<string, Json> = () => ({}),
): Promise<Outcome<T>> {
  try {
    const value = await run();
    record(step, { request, ok: true, ...facts(value) });
    return { ok: true, value };
  } catch (error) {
    const failure = errorFacts(error);
    record(step, { request, ok: false, status: failure.status, reasons: failure.reasons, message: failure.message });
    return { ok: false, error: failure };
  }
}

// ---------------------------------------------------------------------------------------------
// Drive clients

/** One API client per role, each with its own OAuth2Client: two "clients" share no state. */
interface Client {
  label: string;
  auth: OAuth2Client;
  v3: drive_v3.Drive;
  v2: drive_v2.Drive;
}

function newClient(label: string): Client {
  const auth = new OAuth2Client({ clientId, clientSecret });
  auth.setCredentials({ refresh_token: refreshToken });
  return {
    label,
    auth,
    v3: drive({ version: 'v3', auth, retry: false }),
    v2: drive({ version: 'v2', auth, retry: false }),
  };
}

const created = new Set<string>();

/** Drive query string literal: `\` and `'` escaped. */
const quote = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Every page of the folder's untrashed children (optionally one name). */
async function listChildren(client: Client, folderId: string, name?: string, pageSize = 1000) {
  const files: drive_v3.Schema$File[] = [];
  let pages = 0;
  let pageToken: string | undefined;
  do {
    const q = `${quote(folderId)} in parents and trashed = false${name === undefined ? '' : ` and name = ${quote(name)}`}`;
    const { data } = await client.v3.files.list({ q, fields: LIST_FIELDS, pageSize, pageToken, spaces: 'drive' }, NO_RETRY);
    files.push(...(data.files ?? []));
    pageToken = data.nextPageToken ?? undefined;
    pages += 1;
  } while (pageToken);
  return { files, pages };
}

async function getFile(client: Client, fileId: string) {
  const res = await client.v3.files.get({ fileId, fields: FILE_FIELDS }, NO_RETRY);
  return { file: res.data, etag: etagOf(res.headers) };
}

async function getV2Etag(client: Client, fileId: string): Promise<string | undefined> {
  const { data } = await client.v2.files.get({ fileId, fields: 'etag' }, NO_RETRY);
  return data.etag ?? undefined;
}

async function download(client: Client, fileId: string): Promise<Buffer> {
  const res = await client.v3.files.get({ fileId, alt: 'media' }, { ...NO_RETRY, responseType: 'arraybuffer' });
  return Buffer.from(res.data as unknown as ArrayBuffer);
}

async function downloadRevision(client: Client, fileId: string, revisionId: string): Promise<Buffer> {
  const res = await client.v3.revisions.get(
    { fileId, revisionId, alt: 'media' },
    { ...NO_RETRY, responseType: 'arraybuffer' },
  );
  return Buffer.from(res.data as unknown as ArrayBuffer);
}

async function createFile(client: Client, name: string, text: string, id?: string) {
  const res = await client.v3.files.create(
    {
      requestBody: { name, parents: [probeFolderId!], mimeType: MARKDOWN_MIME, ...(id ? { id } : {}) },
      media: { mimeType: MARKDOWN_MIME, body: text },
      fields: FILE_FIELDS,
    },
    NO_RETRY,
  );
  if (res.data.id) created.add(res.data.id);
  return res.data;
}

/** v3 files.update, uploadType=media; `ifMatch` adds the precondition header. */
async function updateV3(client: Client, fileId: string, text: string, ifMatch?: string) {
  const res = await client.v3.files.update(
    { fileId, media: { mimeType: MARKDOWN_MIME, body: text }, fields: FILE_FIELDS },
    { ...NO_RETRY, ...(ifMatch ? { headers: { 'If-Match': ifMatch } } : {}) },
  );
  return res.data;
}

/** v2 files.update (PUT on upload/drive/v2), uploadType=media; `ifMatch` adds the precondition header. */
async function updateV2(client: Client, fileId: string, text: string, ifMatch?: string) {
  const res = await client.v2.files.update(
    { fileId, media: { mimeType: MARKDOWN_MIME, body: text } },
    { ...NO_RETRY, ...(ifMatch ? { headers: { 'If-Match': ifMatch } } : {}) },
  );
  return { etag: res.data.etag, version: res.data.version, headRevisionId: res.data.headRevisionId };
}

async function trash(client: Client, fileId: string) {
  await client.v3.files.update({ fileId, requestBody: { trashed: true }, fields: 'id' }, NO_RETRY);
}

const probeName = (label: string) => `probe-${runId}-${label}.md`;
const bodyFacts = (bytes: Buffer) => ({ bodySha256: sha256(bytes), body: bytes.toString('utf8') });

async function waitForEnter(message: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  await rl.question(`[probe:drive] ${message} — press Enter to continue `);
  rl.close();
}

// ---------------------------------------------------------------------------------------------
// Guard: the probe folder must be a dedicated, untrashed folder

async function checkProbeFolder(client: Client): Promise<void> {
  let folder: drive_v3.Schema$File;
  try {
    folder = (await getFile(client, probeFolderId!)).file;
  } catch (error) {
    const facts = errorFacts(error);
    fail(`Cannot read GOOGLE_DRIVE_PROBE_FOLDER_ID (HTTP ${facts.status ?? '?'}: ${facts.message}).`);
  }
  record('guard', { folder: fileFacts(folder) });
  if (folder.mimeType !== FOLDER_MIME) fail('GOOGLE_DRIVE_PROBE_FOLDER_ID is not a folder.');
  if (folder.trashed) fail('The probe folder is in the trash.');
  if (!folder.name?.startsWith(PROBE_FOLDER_PREFIX)) {
    fail(`The probe folder's name must start with "${PROBE_FOLDER_PREFIX}"; nothing was done.`);
  }
}

// ---------------------------------------------------------------------------------------------
// P-01: scopes, reading existing files, creating and updating a probe file

async function p01(a: Client): Promise<void> {
  const { token } = await a.auth.getAccessToken();
  await attempt('1 tokeninfo', { api: 'oauth2 tokeninfo' }, () => a.auth.getTokenInfo(token!), (info) => ({
    grantedScopes: info.scopes,
  }));

  await attempt(
    '2 calendar',
    { api: 'calendar.calendarList.list', maxResults: 1 },
    () => calendar({ version: 'v3', auth: a.auth, retry: false }).calendarList.list({ maxResults: 1 }, NO_RETRY),
    (res) => ({ status: res.status }),
  );

  await attempt('3 folder', { api: 'files.get', target: 'probe folder' }, () => getFile(a, probeFolderId!), (r) => ({
    folder: { ...fileFacts(r.file), parents: r.file.parents ?? [] },
  }));

  const listed = await attempt(
    '4 list',
    { api: 'files.list', q: "'<probe folder>' in parents and trashed = false", pageSize: 2 },
    () => listChildren(a, probeFolderId!, undefined, 2),
    (r) => ({ pages: r.pages, count: r.files.length, names: r.files.map((f) => f.name ?? null) }),
  );

  const manualFile = listed.ok
    ? listed.value.files.find((f) => f.name?.endsWith('.md') && !f.name.startsWith('probe-') && f.mimeType !== FOLDER_MIME)
    : undefined;
  if (!manualFile?.id) {
    record('5 manual file', { skipped: 'no .md file other than probe files in the probe folder (see plan §4.1)' });
  } else {
    await attempt(
      '5 manual file',
      { api: 'files.get + alt=media', target: 'manual file' },
      async () => ({ meta: (await getFile(a, manualFile.id!)).file, bytes: await download(a, manualFile.id!) }),
      ({ meta, bytes }) => ({
        file: fileFacts(meta),
        downloadedBytes: bytes.length,
        md5Matches: createHash('md5').update(bytes).digest('hex') === meta.md5Checksum,
        bodySha256: sha256(bytes),
      }),
    );
    const upper = manualFile.name!.toUpperCase();
    await attempt(
      '6 name case',
      { api: 'files.list', q: "name = '<manual file name in upper case>'", nameDiffersFromFile: upper !== manualFile.name },
      () => listChildren(a, probeFolderId!, upper),
      (r) => ({ count: r.files.length, names: r.files.map((f) => f.name ?? null) }),
    );
  }

  const name = probeName("日本語 it's");
  const createdFile = await attempt(
    '7 create',
    { api: 'files.create', uploadType: 'multipart', mimeType: MARKDOWN_MIME, name },
    () => createFile(a, name, '# Probe\n\n作成した本文\n'),
    (file) => ({ file: fileFacts(file) }),
  );
  if (!createdFile.ok || !createdFile.value.id) return;
  const fileId = createdFile.value.id;
  await attempt('7 find by escaped name', { api: 'files.list', name }, () => listChildren(a, probeFolderId!, name), (r) => ({
    count: r.files.length,
    exactMatches: r.files.filter((f) => f.name === name).length,
  }));

  const updated = await attempt(
    '8 update',
    { api: 'files.update', version: 'v3', uploadType: 'media' },
    () => updateV3(a, fileId, '# Probe\n\n作成した本文\n\n更新した本文\n'),
    (file) => ({ before: fileFacts(createdFile.value), after: fileFacts(file) }),
  );
  if (updated.ok && updated.value.headRevisionId) {
    const revisionId = updated.value.headRevisionId;
    await attempt(
      '9 revision download',
      { api: 'revisions.get alt=media', revision: 'head after step 8' },
      async () => ({ revision: await downloadRevision(a, fileId, revisionId), current: await download(a, fileId) }),
      ({ revision, current }) => ({ ...bodyFacts(revision), matchesCurrent: revision.equals(current) }),
    );
  }

  if (!vaultFolderId) {
    record('10 vault folder', { skipped: 'GOOGLE_DRIVE_VAULT_FOLDER_ID is not set' });
  } else {
    // Metadata only: no other request is ever sent for the real vault.
    await attempt('10 vault folder', { api: 'files.get', target: 'vault folder' }, () => getFile(a, vaultFolderId), (r) => ({
      mimeType: r.file.mimeType,
      trashed: r.file.trashed,
      ownedByMe: r.file.ownedByMe,
      driveId: r.file.driveId ?? null,
      inSharedDrive: !!r.file.driveId,
    }));
  }
}

// ---------------------------------------------------------------------------------------------
// P-02: does a conditional update reject a write based on stale content?

interface Snapshot {
  meta: drive_v3.Schema$File;
  v3Etag: string | undefined;
  v2Etag: string | undefined;
  bytes: Buffer;
}

async function snapshot(client: Client, fileId: string): Promise<Snapshot> {
  const { file, etag } = await getFile(client, fileId);
  return { meta: file, v3Etag: etag, v2Etag: await getV2Etag(client, fileId), bytes: await download(client, fileId) };
}

const snapshotFacts = (s: Snapshot) => ({
  version: s.meta.version,
  headRevisionId: s.meta.headRevisionId,
  md5Checksum: s.meta.md5Checksum,
  v3EtagHeader: s.v3Etag ?? null,
  v2Etag: s.v2Etag ?? null,
  bodySha256: sha256(s.bytes),
});

const BASE = '# Probe\n\nbase\n';

async function p02(a: Client, b: Client): Promise<void> {
  for (const variant of ['v3', 'v2'] as const) {
    const step = variant === 'v3' ? '3a' : '3b';
    const file = await createFile(a, probeName(`p02-${variant}`), BASE);
    const fileId = file.id!;
    record(`${step} setup`, { file: fileFacts(file) });

    const seenByA = await snapshot(a, fileId);
    const seenByB = await snapshot(b, fileId);
    record(`${step} 1 read`, { a: snapshotFacts(seenByA), b: snapshotFacts(seenByB) });

    await attempt(`${step} 2 A updates`, { api: 'files.update', version: 'v3', uploadType: 'media', condition: 'none' }, () =>
      updateV3(a, fileId, `${seenByA.bytes.toString('utf8')}\nappended by A\n`),
      (f) => ({ file: fileFacts(f) }),
    );

    const staleText = `${seenByB.bytes.toString('utf8')}\nappended by B from the stale read\n`;
    const ifMatch = variant === 'v3' ? seenByB.v3Etag : seenByB.v2Etag;
    let rejected = false;
    if (!ifMatch) {
      record(`${step} 3 B conditional update`, { skipped: `B got no ${variant} etag to send in If-Match` });
    } else {
      const result = await attempt(
        `${step} 3 B conditional update`,
        { api: 'files.update', version: variant, uploadType: 'media', ifMatch: 'etag from B\'s read (stale)' },
        () => (variant === 'v3' ? updateV3(b, fileId, staleText, ifMatch) : updateV2(b, fileId, staleText, ifMatch)),
      );
      rejected = !result.ok;
    }
    record(`${step} 3 final body`, bodyFacts(await download(a, fileId)));

    if (rejected) {
      // Positive control: the same precondition with fresh values must succeed.
      const fresh = await snapshot(b, fileId);
      const freshMatch = variant === 'v3' ? fresh.v3Etag : fresh.v2Etag;
      const freshText = `${fresh.bytes.toString('utf8')}\nappended by B after a fresh read\n`;
      if (!freshMatch) {
        record(`3c ${variant} fresh conditional update`, { skipped: `the fresh read returned no ${variant} etag` });
        continue;
      }
      await attempt(
        `3c ${variant} fresh conditional update`,
        { api: 'files.update', version: variant, uploadType: 'media', ifMatch: 'etag from a fresh read' },
        () => (variant === 'v3' ? updateV3(b, fileId, freshText, freshMatch) : updateV2(b, fileId, freshText, freshMatch)),
      );
      record(`3c ${variant} final body`, bodyFacts(await download(a, fileId)));
    }
  }

  // Step 4: the gap between reading metadata and reading content.
  const gapFile = await createFile(a, probeName('p02-gap'), BASE);
  const gapId = gapFile.id!;
  const r1 = (await getFile(b, gapId)).file;
  record('4 1 B reads metadata', { file: fileFacts(r1) });
  const r2 = await updateV3(a, gapId, `${BASE}\nappended by A between B's metadata and content reads\n`);
  record('4 2 A updates', { file: fileFacts(r2) });
  await attempt('4 3 B alt=media', { api: 'files.get alt=media' }, () => download(b, gapId), (bytes) => ({
    ...bodyFacts(bytes),
    isContentOfR1: sha256(bytes) === sha256(BASE),
  }));
  if (r1.headRevisionId) {
    const revisionId = r1.headRevisionId;
    await attempt(
      '4 4 B revisions.get r1',
      { api: 'revisions.get alt=media', revision: 'r1 (from B\'s metadata read)' },
      () => downloadRevision(b, gapId, revisionId),
      (bytes) => ({ ...bodyFacts(bytes), isContentOfR1: sha256(bytes) === sha256(BASE) }),
    );
  } else {
    record('4 4 B revisions.get r1', { skipped: 'no headRevisionId in B\'s metadata read' });
  }

  // Step 5 (baseline, last): an unconditional update from stale content.
  const baseFile = await createFile(a, probeName('p02-baseline'), BASE);
  const baseId = baseFile.id!;
  const stale = await download(b, baseId);
  await updateV3(a, baseId, `${BASE}\nappended by A\n`);
  await attempt('5 B unconditional stale update', { api: 'files.update', version: 'v3', condition: 'none' }, () =>
    updateV3(b, baseId, `${stale.toString('utf8')}\nappended by B from the stale read\n`),
  );
  const finalBytes = await download(a, baseId);
  record('5 final body', { ...bodyFacts(finalBytes), keepsA: finalBytes.toString('utf8').includes('appended by A') });

  if (manual) await p02Manual(a, b);
}

async function p02Manual(a: Client, b: Client): Promise<void> {
  const name = probeName('p02m');
  const file = await createFile(a, name, BASE);
  const fileId = file.id!;
  await waitForEnter(`P-02m: wait until "${name}" appears in the synced probe folder on this PC`);
  const seen = await snapshot(b, fileId);
  record('P-02m 1 B reads', snapshotFacts(seen));
  await waitForEnter(`P-02m: edit and save "${name}" in the synced folder, and wait until Drive for desktop has synced it`);
  const text = `${seen.bytes.toString('utf8')}\nappended by B from the read before the local edit\n`;
  for (const variant of ['v3', 'v2'] as const) {
    const ifMatch = variant === 'v3' ? seen.v3Etag : seen.v2Etag;
    if (!ifMatch) {
      record(`P-02m 2 ${variant}`, { skipped: `no ${variant} etag` });
      continue;
    }
    await attempt(`P-02m 2 ${variant} conditional update`, { api: 'files.update', version: variant, ifMatch: 'etag from B\'s read' }, () =>
      variant === 'v3' ? updateV3(b, fileId, text, ifMatch) : updateV2(b, fileId, text, ifMatch),
    );
  }
  record('P-02m 3 final body', bodyFacts(await download(a, fileId)));
  await waitForEnter('P-02m: note the state of the synced folder (conflict copies?) in the evidence');
}

// ---------------------------------------------------------------------------------------------
// P-03: creating the same name at the same time

/** §10.2 of the plan: never pick a winner — when another item with the name is seen, undo our own. */
interface Creator {
  client: Client;
  name: string;
  fileId?: string;
  outcome?: 'success' | 'conflict-before' | 'conflict-after' | 'undo-failed' | 'create-failed';
}

async function precheck(c: Creator): Promise<boolean> {
  const { files } = await listChildren(c.client, probeFolderId!, c.name);
  const others = files.filter((f) => f.name === c.name);
  record('precheck', { client: c.client.label, seen: others.length });
  if (others.length > 0) c.outcome = 'conflict-before';
  return others.length === 0;
}

async function create(c: Creator, text: string): Promise<void> {
  try {
    const file = await createFile(c.client, c.name, text);
    c.fileId = file.id ?? undefined;
    record('create', { client: c.client.label, file: fileFacts(file) });
  } catch (error) {
    c.outcome = 'create-failed';
    record('create', { client: c.client.label, ok: false, ...errorFacts(error) });
  }
}

async function postcheck(c: Creator): Promise<void> {
  if (!c.fileId) return;
  const { files } = await listChildren(c.client, probeFolderId!, c.name);
  const others = files.filter((f) => f.name === c.name && f.id !== c.fileId);
  record('postcheck', { client: c.client.label, seenOthers: others.map((f) => fileFacts(f)) });
  if (others.length === 0) {
    c.outcome = 'success';
    return;
  }
  try {
    await trash(c.client, c.fileId);
    c.outcome = 'conflict-after';
  } catch (error) {
    c.outcome = 'undo-failed';
    record('undo', { client: c.client.label, ok: false, ...errorFacts(error) });
  }
}

async function remaining(client: Client, name: string) {
  const { files } = await listChildren(client, probeFolderId!, name);
  return files.filter((f) => f.name === name);
}

async function summarize(step: string, creators: Creator[], reader: Client): Promise<void> {
  const left = await remaining(reader, creators[0]!.name);
  record(step, {
    outcomes: creators.map((c) => ({ client: c.client.label, outcome: c.outcome ?? null, fileId: c.fileId ?? null })),
    successes: creators.filter((c) => c.outcome === 'success').length,
    remaining: left.length,
    remainingIds: left.map((f) => f.id ?? null),
  });
}

async function p03(clients: Client[]): Promise<void> {
  const [a, b] = clients as [Client, Client];

  // Step 1–2: plain concurrent creates, then how soon a list sees all of them.
  for (const count of [2, 5]) {
    for (let round = 1; round <= 3; round += 1) {
      const name = probeName(`p03-plain-${count}-${round}`);
      const results = await Promise.allSettled(clients.slice(0, count).map((c) => createFile(c, name, `${c.label}\n`)));
      record(`1 concurrent create x${count} #${round}`, {
        results: results.map((r, i) =>
          r.status === 'fulfilled'
            ? { client: clients[i]!.label, ok: true, id: r.value.id ?? null }
            : { client: clients[i]!.label, ok: false, ...(errorFacts(r.reason) as unknown as Record<string, Json>) },
        ),
      });
      for (const delay of [0, 1000, 5000]) {
        if (delay > 0) await sleep(delay);
        const seen = await remaining(a, name);
        record(`2 list after ${delay}ms x${count} #${round}`, { seen: seen.length, ids: seen.map((f) => f.id ?? null) });
      }
    }
  }

  // Step 3a: both prechecks → A creates → A postchecks → B creates → B postchecks.
  {
    const name = probeName('p03-order-a');
    const [ca, cb]: Creator[] = [{ client: a, name }, { client: b, name }];
    const okA = await precheck(ca!);
    const okB = await precheck(cb!);
    if (okA) await create(ca!, 'A\n');
    await postcheck(ca!);
    if (okB) await create(cb!, 'B\n');
    await postcheck(cb!);
    await summarize('3a result', [ca!, cb!], a);
  }

  // Step 3b: both prechecks → A creates → B creates → A postchecks → B postchecks.
  {
    const name = probeName('p03-order-b');
    const [ca, cb]: Creator[] = [{ client: a, name }, { client: b, name }];
    const okA = await precheck(ca!);
    const okB = await precheck(cb!);
    if (okA) await create(ca!, 'A\n');
    if (okB) await create(cb!, 'B\n');
    await postcheck(ca!);
    await postcheck(cb!);
    await summarize('3b result', [ca!, cb!], a);
  }

  // Step 3c: the whole procedure from 5 clients at once, 10 times (reference only).
  for (let round = 1; round <= 10; round += 1) {
    const name = probeName(`p03-procedure-${round}`);
    const creators: Creator[] = clients.map((client) => ({ client, name }));
    await Promise.all(
      creators.map(async (c) => {
        if (!(await precheck(c))) return;
        await create(c, `${c.client.label}\n`);
        await postcheck(c);
      }),
    );
    await summarize(`3c result #${round}`, creators, a);
  }

  // Step 4: two creates with the same generated ID (uniqueness of IDs, not of names).
  {
    const { data } = await a.v3.files.generateIds({ count: 1, space: 'drive', type: 'files' }, NO_RETRY);
    const id = data.ids?.[0];
    if (!id) {
      record('4 generated id', { skipped: 'generateIds returned no ID' });
    } else {
      const name = probeName('p03-same-id');
      const results = await Promise.allSettled([createFile(a, name, 'A\n', id), createFile(b, name, 'B\n', id)]);
      record('4 same generated id', {
        results: results.map((r, i) =>
          r.status === 'fulfilled'
            ? { client: [a, b][i]!.label, ok: true, id: r.value.id ?? null }
            : { client: [a, b][i]!.label, ok: false, ...(errorFacts(r.reason) as unknown as Record<string, Json>) },
        ),
        remaining: (await remaining(a, name)).length,
      });
    }
  }

  if (manual) {
    const name = probeName('p03m');
    await waitForEnter(`P-03m: get ready to create "${name}" in the synced probe folder; press Enter as you save it`);
    const creator: Creator = { client: a, name };
    await create(creator, 'created by the API\n');
    await waitForEnter('P-03m: wait until Drive for desktop has synced');
    const left = await remaining(a, name);
    const similar = (await listChildren(a, probeFolderId!)).files.filter((f) => f.name?.startsWith(name.slice(0, -'.md'.length)));
    record('P-03m result', { exactName: left.map(fileFacts), similarNames: similar.map((f) => f.name ?? null) });
  }
}

// ---------------------------------------------------------------------------------------------

async function cleanup(client: Client): Promise<void> {
  if (keep) {
    record('cleanup', { skipped: '--keep', created: [...created] });
    return;
  }
  const results = await Promise.allSettled([...created].map((fileId) => trash(client, fileId)));
  record('cleanup', {
    trashed: results.filter((r) => r.status === 'fulfilled').length,
    failed: results.filter((r) => r.status === 'rejected').length,
  });
}

async function main(): Promise<void> {
  const clients = ['A', 'B', 'C', 'D', 'E'].map(newClient);
  const a = clients[0]!;
  await checkProbeFolder(a);
  progress(`run ${runId}: ${probe}${keep ? ' (--keep)' : ''}${manual ? ' (--manual)' : ''}`);
  try {
    if (probe === 'p01') await p01(a);
    else if (probe === 'p02') await p02(a, clients[1]!);
    else await p03(clients);
  } finally {
    await cleanup(a);
  }
  progress('done');
}

main().catch((error: unknown) => {
  const facts = errorFacts(error);
  record('aborted', { status: facts.status, reasons: facts.reasons, message: facts.message });
  fail(`aborted: ${facts.message}`);
});
