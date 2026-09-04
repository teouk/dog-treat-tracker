import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Storage seam for the master workbook.
 *
 * Everything above this interface — header mapping, value calculation, cell
 * patching — deals in bytes and knows nothing about where the file lives.
 * Moving from the local test file to OneDrive is therefore a matter of adding
 * a second implementation and flipping `WORKBOOK_DRIVER`, with no change to
 * the sync logic itself.
 */
export interface WorkbookStore {
  /** Stable identifier for logs and API responses. */
  readonly id: string;
  /** Human-readable location, safe to show in the UI. */
  describe(): string;
  /** Current workbook bytes. */
  read(): Promise<Buffer>;
  /** Replace the workbook. Implementations must be atomic where possible. */
  write(data: Buffer, meta: WriteMeta): Promise<void>;
}

export type WriteMeta = {
  /** Who or what triggered the write, recorded alongside backups. */
  actor?: string | null;
  /** Short description of the change, e.g. "stock sync". */
  reason?: string;
};

export class WorkbookUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbookUnavailableError';
  }
}

// --------------------------------------------------------------------------
// Local file system (test phase)
// --------------------------------------------------------------------------

const DEFAULT_WORKBOOK_PATH = path.join(process.cwd(), 'data', 'glorious stok.xlsx');

/**
 * Reads and writes the workbook on the local disk.
 *
 * Writes are staged to a temporary file and renamed into place, so a crash
 * mid-write cannot leave a truncated workbook where the master used to be.
 * Every write is preceded by a timestamped backup, which during the test
 * phase is the difference between "we broke the file" and "we restored it".
 */
export class LocalFileStore implements WorkbookStore {
  readonly id = 'local';
  private readonly filePath: string;
  private readonly backupDir: string;
  private readonly keepBackups: number;

  constructor(options: { filePath?: string; backupDir?: string; keepBackups?: number } = {}) {
    this.filePath = options.filePath ?? process.env.WORKBOOK_PATH ?? DEFAULT_WORKBOOK_PATH;
    this.backupDir = options.backupDir
      ?? process.env.WORKBOOK_BACKUP_DIR
      ?? path.join(path.dirname(this.filePath), 'backups');
    this.keepBackups = options.keepBackups ?? Number(process.env.WORKBOOK_KEEP_BACKUPS ?? 20);
  }

  describe(): string {
    return this.filePath;
  }

  async read(): Promise<Buffer> {
    try {
      return await fs.readFile(this.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new WorkbookUnavailableError(
          `Workbook not found at ${this.filePath}. ` +
          `Place the .xlsx there or set WORKBOOK_PATH.`
        );
      }
      throw error;
    }
  }

  async write(data: Buffer, meta: WriteMeta = {}): Promise<void> {
    await this.backup(meta);

    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, data);
    try {
      await fs.rename(temp, this.filePath);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  /** Copy the current file aside before overwriting it, then prune old copies. */
  private async backup(meta: WriteMeta): Promise<void> {
    let current: Buffer;
    try {
      current = await fs.readFile(this.filePath);
    } catch {
      return; // Nothing to back up on a first write.
    }

    await fs.mkdir(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tag = (meta.reason ?? 'write').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const base = path.basename(this.filePath, path.extname(this.filePath));
    await fs.writeFile(path.join(this.backupDir, `${base}.${stamp}.${tag}.xlsx`), current);

    if (this.keepBackups <= 0) return;
    const entries = (await fs.readdir(this.backupDir))
      .filter(name => name.startsWith(`${base}.`) && name.endsWith('.xlsx'))
      .sort()
      .reverse();
    await Promise.all(
      entries.slice(this.keepBackups).map(name =>
        fs.rm(path.join(this.backupDir, name), { force: true })
      )
    );
  }
}

// --------------------------------------------------------------------------
// Microsoft Graph (next phase)
// --------------------------------------------------------------------------

/**
 * OneDrive / SharePoint implementation, deliberately left unimplemented until
 * the tenant app registration exists.
 *
 * The two calls it needs, once credentials are in place:
 *
 *   read:  GET  /v1.0/drives/{driveId}/items/{itemId}/content
 *   write: PUT  /v1.0/drives/{driveId}/items/{itemId}/content        (< 4 MB)
 *          or an upload session for larger files:
 *          POST /v1.0/drives/{driveId}/items/{itemId}/createUploadSession
 *
 * Two things will differ from the local store and are worth planning for now:
 *
 *   - Concurrency. Graph has no rename-into-place. Capture the item's `eTag`
 *     on read and send it back as `If-Match` on write, so a write fails
 *     loudly if someone edited the workbook in Excel Online meanwhile.
 *   - Cost. Each sync becomes two network round trips of the whole file, so
 *     the per-adjustment auto-sync should be debounced or moved to a queue
 *     rather than run inline on every stock change.
 */
export class GraphWorkbookStore implements WorkbookStore {
  readonly id = 'graph';

  describe(): string {
    return 'Microsoft Graph (not configured)';
  }

  async read(): Promise<Buffer> {
    throw new WorkbookUnavailableError(
      'The Microsoft Graph workbook store is not implemented yet. ' +
      'Set WORKBOOK_DRIVER=local to use the local test file.'
    );
  }

  async write(): Promise<void> {
    throw new WorkbookUnavailableError(
      'The Microsoft Graph workbook store is not implemented yet. ' +
      'Set WORKBOOK_DRIVER=local to use the local test file.'
    );
  }
}

/** Pick the store for the current environment. */
export function getWorkbookStore(): WorkbookStore {
  const driver = (process.env.WORKBOOK_DRIVER ?? 'local').toLowerCase();
  switch (driver) {
    case 'graph':
    case 'onedrive':
    case 'sharepoint':
      return new GraphWorkbookStore();
    case 'local':
    case '':
      return new LocalFileStore();
    default:
      throw new Error(`Unknown WORKBOOK_DRIVER "${driver}". Expected "local" or "graph".`);
  }
}
