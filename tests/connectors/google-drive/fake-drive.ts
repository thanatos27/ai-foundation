import {
  DRIVE_FOLDER_MIME,
  DRIVE_SHORTCUT_MIME,
  type DriveApi,
  type DriveItem,
  type DriveRevision,
  StaleRevisionError,
} from '../../../src/connectors/google-drive/client.js';

/** An error as googleapis throws it: `status`, and Google's reasons in the response body. */
export function googleError(status: number | undefined, reason?: string, message = `request failed (${status ?? 'no response'})`) {
  return Object.assign(new Error(message), {
    status,
    response: status === undefined ? undefined : { status, data: { error: { message, errors: reason ? [{ reason }] : [] } } },
  });
}

interface FakeItem {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  parent: string | undefined;
  modifiedTime: string;
  etag: string;
  revisions: { id: string; bytes: Buffer }[];
}

export type DriveMethod = keyof DriveApi;

/**
 * Google Drive in memory, behind the `DriveApi` the storages use. Like Drive: names are not unique,
 * name queries ignore case, trashed items are not listed, and the etag (opaque) changes on every
 * update. Tests can pause or fail any call (`before`), add items as another writer would, and hold
 * created files back from listings (`lagCreates` / `hidden`).
 */
export class FakeDrive implements DriveApi {
  readonly root: string;
  readonly calls: { method: DriveMethod; args: unknown[] }[] = [];
  /** Runs before every call (after it is recorded): throw to fail it, await to pause it. */
  before: ((method: DriveMethod, args: unknown[]) => void | Promise<void>) | undefined;
  /** Files created through `createFile` stay out of listings until `settle()`. */
  lagCreates = false;
  /** Items listings do not show yet. */
  readonly hidden = new Set<string>();
  private readonly items = new Map<string, FakeItem>();
  private next = 0;
  private clock = Date.parse('2026-11-14T00:00:00.000Z');

  constructor() {
    this.root = this.add(undefined, 'Vault', DRIVE_FOLDER_MIME);
  }

  // --- Building the vault (as Drive for desktop or another client would) ---------------------

  /** Folders along `path` below the vault root, creating missing ones; returns the last folder's ID. */
  mkdirs(path: string): string {
    let current = this.root;
    for (const name of path.split('/')) {
      const existing = this.childrenOf(current).find((item) => item.name === name && item.mimeType === DRIVE_FOLDER_MIME);
      current = existing?.id ?? this.add(current, name, DRIVE_FOLDER_MIME);
    }
    return current;
  }

  /** A file at a vault-relative path (folders created as needed). */
  write(path: string, content: string | Buffer, mimeType = 'text/plain'): string {
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? this.root : this.mkdirs(path.slice(0, slash));
    return this.add(parent, path.slice(slash + 1), mimeType, content);
  }

  add(parent: string | undefined, name: string, mimeType: string, content?: string | Buffer): string {
    const id = `id-${String(++this.next).padStart(4, '0')}-${Math.random().toString(36).slice(2, 8)}`;
    const item: FakeItem = {
      id,
      name,
      mimeType,
      trashed: false,
      parent,
      modifiedTime: this.tick(),
      etag: this.etag(),
      revisions: [],
    };
    if (content !== undefined) item.revisions.push({ id: `rev-${++this.next}`, bytes: Buffer.from(content) });
    this.items.set(id, item);
    return id;
  }

  shortcut(parent: string, name: string): string {
    return this.add(parent, name, DRIVE_SHORTCUT_MIME);
  }

  /** Another client's ordinary update: a new revision, a new etag and modified time. */
  externalUpdate(id: string, content: string | Buffer): void {
    const item = this.item(id);
    item.revisions.push({ id: `rev-${++this.next}`, bytes: Buffer.from(content) });
    item.modifiedTime = this.tick();
    item.etag = this.etag();
  }

  trashItem(id: string): void {
    this.item(id).trashed = true;
  }

  rename(id: string, name: string): void {
    this.item(id).name = name;
  }

  settle(): void {
    this.hidden.clear();
  }

  // --- Inspecting --------------------------------------------------------------------------

  /** Untrashed items named exactly `name` in the folder. */
  named(parent: string, name: string): DriveItem[] {
    return this.childrenOf(parent, true).filter((item) => item.name === name);
  }

  /** The ID of the one item at a vault-relative path. */
  idAt(path: string): string {
    let current = this.root;
    for (const name of path.split('/')) {
      const [item, ...others] = this.named(current, name);
      if (!item || others.length > 0) throw new Error(`fake: no single item at ${path}`);
      current = item.id;
    }
    return current;
  }

  bytes(id: string): Buffer {
    return this.item(id).revisions.at(-1)?.bytes ?? Buffer.alloc(0);
  }

  text(id: string): string {
    return this.bytes(id).toString('utf8');
  }

  mimeTypeOf(id: string): string {
    return this.item(id).mimeType;
  }

  /** Every untrashed item (files and folders), for "nothing was deleted" checks. */
  get count(): number {
    return [...this.items.values()].filter((item) => !item.trashed).length;
  }

  callsOf(method: DriveMethod): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  // --- DriveApi ----------------------------------------------------------------------------

  async getItem(fileId: string): Promise<DriveItem> {
    await this.enter('getItem', [fileId]);
    return this.toItem(this.found(fileId));
  }

  async listChildren(folderId: string, options: { name?: string } = {}): Promise<DriveItem[]> {
    await this.enter('listChildren', [folderId, options]);
    const name = options.name?.toLowerCase();
    return this.childrenOf(folderId)
      .filter((item) => !this.hidden.has(item.id))
      .filter((item) => name === undefined || item.name.toLowerCase() === name);
  }

  async download(fileId: string): Promise<Buffer> {
    await this.enter('download', [fileId]);
    return Buffer.from(this.bytes(this.found(fileId).id));
  }

  async revisionOf(fileId: string): Promise<DriveRevision> {
    await this.enter('revisionOf', [fileId]);
    const item = this.found(fileId);
    const head = item.revisions.at(-1);
    if (!head) throw googleError(404, 'notFound');
    return { fileId, etag: item.etag, headRevisionId: head.id, mimeType: item.mimeType };
  }

  async downloadRevision(revision: DriveRevision): Promise<Buffer> {
    await this.enter('downloadRevision', [revision]);
    const found = this.found(revision.fileId).revisions.find((r) => r.id === revision.headRevisionId);
    if (!found) throw googleError(404, 'notFound');
    return Buffer.from(found.bytes);
  }

  async createFile(parentId: string, name: string, text: string): Promise<DriveItem> {
    await this.enter('createFile', [parentId, name, text]);
    const id = this.add(parentId, name, 'text/markdown', text);
    if (this.lagCreates) this.hidden.add(id);
    return this.toItem(this.item(id));
  }

  async updateContent(revision: DriveRevision, bytes: Buffer): Promise<void> {
    await this.enter('updateContent', [revision, bytes]);
    const item = this.found(revision.fileId);
    if (item.etag !== revision.etag) throw new StaleRevisionError('precondition failed');
    item.revisions.push({ id: `rev-${++this.next}`, bytes: Buffer.from(bytes) });
    item.modifiedTime = this.tick();
    item.etag = this.etag();
  }

  // --- Internals ---------------------------------------------------------------------------

  private async enter(method: DriveMethod, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    await this.before?.(method, args);
  }

  private childrenOf(parent: string, includeHidden = false): DriveItem[] {
    return [...this.items.values()]
      .filter((item) => item.parent === parent && !item.trashed && (includeHidden || !this.hidden.has(item.id)))
      .map((item) => this.toItem(item));
  }

  /** The item for an API call by ID: a missing one is a 404. As in Drive, a trashed item is still served by its ID. */
  private found(id: string): FakeItem {
    const item = this.items.get(id);
    if (!item) throw googleError(404, 'notFound');
    return item;
  }

  private item(id: string): FakeItem {
    const item = this.items.get(id);
    if (!item) throw new Error(`fake: no item ${id}`);
    return item;
  }

  private toItem({ id, name, mimeType, trashed, modifiedTime }: FakeItem): DriveItem {
    return { id, name, mimeType, trashed, modifiedTime };
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private etag(): string {
    return `"etag-${++this.next}"`;
  }
}
