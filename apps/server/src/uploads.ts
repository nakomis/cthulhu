import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * One upload Cthulhu has sent to the printer.
 *
 * `uploadedAt` is kept for good, so the file list can be sorted by when it
 * arrived. The bytes (`cached`) are kept only while they fit the cache
 * budget, so the Status panel can show layer previews without fetching the
 * whole file back from the printer - the printer does not serve layer images,
 * they live inside the .goo. See PrintView.
 */
export interface UploadEntry {
  /** The printer's own path, e.g. /local/model.goo - what /api/files reports. */
  path: string;
  /** The file's own name, used to match a running print back to its bytes. */
  filename: string;
  uploadedAt: number;
  size: number;
  /** Whether the bytes are still on disk here (false once evicted). */
  cached: boolean;
}

interface StoredEntry extends UploadEntry {
  /** The name of the bytes file within the store dir. */
  file: string;
}

export interface UploadStoreOptions {
  dir: string;
  /** How many bytes of cached .goo files to keep before evicting the oldest. */
  maxCacheBytes: number;
  now?: () => number;
  log?: (line: string) => void;
}

const INDEX = 'index.json';

/**
 * A record of every file Cthulhu has uploaded, and a bounded cache of their
 * bytes.
 *
 * Two jobs, because both are learned at the same moment - the upload:
 *  - the upload time, kept for every file so the list can be sorted by it;
 *  - the bytes, kept for the most recently uploaded files up to a size
 *    budget, so layer previews need no round trip to the printer.
 *
 * The metadata outlives the bytes: a file whose bytes were evicted still sorts
 * correctly, it just falls back to re-fetching from the printer for a preview.
 */
export class UploadStore {
  private readonly dir: string;
  private readonly maxCacheBytes: number;
  private readonly now: () => number;
  private readonly log: ((line: string) => void) | undefined;
  private readonly entries = new Map<string, StoredEntry>();

  constructor(options: UploadStoreOptions) {
    this.dir = options.dir;
    this.maxCacheBytes = options.maxCacheBytes;
    this.now = options.now ?? Date.now;
    this.log = options.log;
    this.loadIndex();
  }

  /** When this file was uploaded, or undefined if Cthulhu never sent it. */
  uploadedAt(path: string): number | undefined {
    return this.entries.get(path)?.uploadedAt;
  }

  /** Every known upload, newest first. */
  all(): UploadEntry[] {
    return [...this.entries.values()]
      .map(({ file: _file, ...entry }) => entry)
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  /**
   * The on-disk path of a cached .goo with this name, or undefined.
   *
   * Matched by the file's own name rather than the full printer path: a print
   * task names the file by the printer's own path (/media/...), which is not
   * the /local/ path it was uploaded under, but the basename is the same. The
   * newest matching upload wins, and the bytes are confirmed present.
   */
  async localPath(filename: string): Promise<string | undefined> {
    const matches = [...this.entries.values()]
      .filter((e) => e.cached && e.filename === filename)
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
    for (const entry of matches) {
      const path = join(this.dir, entry.file);
      if (existsSync(path)) return path;
      // The bytes went missing underneath us; forget them but keep the time.
      entry.cached = false;
      await this.saveIndex();
    }
    return undefined;
  }

  /**
   * Record an upload: its time always, its bytes if they fit the budget.
   *
   * Called after the printer has confirmed the file, so the path is the
   * printer's own. Never throws for a caching problem - a failed cache write
   * must not turn a successful upload into a failure for the caller to guard.
   */
  async record(path: string, filename: string, data: Buffer): Promise<void> {
    const file = `${createHash('sha1').update(path).digest('hex')}.goo`;
    const entry: StoredEntry = {
      path,
      filename,
      uploadedAt: this.now(),
      size: data.length,
      cached: false,
      file,
    };

    // A file bigger than the whole budget is never worth caching - it would
    // evict everything else and still have to go the moment the next one lands.
    if (data.length <= this.maxCacheBytes) {
      try {
        mkdirSync(this.dir, { recursive: true });
        const full = join(this.dir, file);
        const part = `${full}.part`;
        await writeFile(part, data);
        await rename(part, full);
        entry.cached = true;
      } catch (err) {
        this.log?.(`upload store: could not cache ${filename}: ${String(err)}`);
      }
    }

    this.entries.set(path, entry);
    await this.evict();
    await this.saveIndex();
  }

  /** Drop the oldest cached bytes until the cache is within budget. */
  private async evict(): Promise<void> {
    const cached = () => [...this.entries.values()].filter((e) => e.cached);
    let total = cached().reduce((sum, e) => sum + e.size, 0);
    if (total <= this.maxCacheBytes) return;
    const oldestFirst = cached().sort((a, b) => a.uploadedAt - b.uploadedAt);
    for (const entry of oldestFirst) {
      if (total <= this.maxCacheBytes) break;
      try {
        await rm(join(this.dir, entry.file), { force: true });
      } catch (err) {
        this.log?.(`upload store: could not evict ${entry.filename}: ${String(err)}`);
      }
      entry.cached = false;
      total -= entry.size;
    }
  }

  private loadIndex(): void {
    let raw: string;
    try {
      raw = readFileSync(join(this.dir, INDEX), 'utf8');
    } catch {
      return; // No index yet: a fresh store.
    }
    try {
      const parsed = JSON.parse(raw) as { entries?: StoredEntry[] };
      for (const entry of parsed.entries ?? []) {
        // Reconcile the recorded cached flag against what is actually on disk:
        // the bytes are a cache and may have been cleared independently.
        const present = entry.cached && existsSync(join(this.dir, entry.file));
        this.entries.set(entry.path, { ...entry, cached: present });
      }
    } catch (err) {
      this.log?.(`upload store: ignoring unreadable index: ${String(err)}`);
    }
  }

  private async saveIndex(): Promise<void> {
    try {
      mkdirSync(this.dir, { recursive: true });
      const full = join(this.dir, INDEX);
      const part = `${full}.part`;
      await writeFile(part, JSON.stringify({ version: 1, entries: [...this.entries.values()] }));
      await rename(part, full);
    } catch (err) {
      this.log?.(`upload store: could not save index: ${String(err)}`);
    }
  }
}
