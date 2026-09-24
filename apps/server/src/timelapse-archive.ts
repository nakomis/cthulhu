import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { HistoryStore } from './history.js';

// Task ids are UUIDs; nothing else becomes a path. Mirrors isTimelapseId in
// apps/camera/src/timelapse.ts - kept local rather than shared, since the
// two apps deploy separately and neither depends on the other.
const ID = /^[A-Za-z0-9-]{1,64}$/;
export const isArchiveId = (id: string): boolean => ID.test(id);

/** What the camera service's /timelapse list entries look like. Only the fields used here. */
interface RemoteTimelapse {
  id: string;
  state: 'recording' | 'assembling' | 'ready' | 'failed';
  frames: number;
  startedAt: string;
  finishedAt?: string;
  bytes?: number;
  error?: string;
}

export interface ArchivedTimelapse {
  id: string;
  frames: number;
  startedAt: string;
  finishedAt?: string;
  bytes: number;
  /** From cthulhu's own history, by taskId - null when there is no match. */
  filename: string | null;
}

export interface TimelapseArchiverOptions {
  /** The camera service's origin, e.g. http://phi:9121. */
  baseUrl: string;
  /** Where finished time-lapses are archived - a share mounted into the container. */
  dir: string;
  /** For naming an archived time-lapse after the file it printed. */
  history?: HistoryStore;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * Moves finished time-lapses off the camera service and onto the share,
 * where they survive the camera service (and the box it runs on) being
 * rebuilt. See CTHU-16.
 *
 * Deliberately conservative about ordering: the camera service's copy is
 * asked to delete itself only AFTER the archive's own files exist on disk,
 * so a failure partway through - the share going away, the camera service
 * being unreachable - always leaves at least one copy somewhere. Whatever
 * fails is simply retried on the next tick.
 */
export class TimelapseArchiver {
  private readonly options: TimelapseArchiverOptions;
  private readonly fetchImpl: typeof fetch;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: TimelapseArchiverOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    mkdirSync(options.dir, { recursive: true });
  }

  /** Runs once now, then every intervalMs. */
  start(intervalMs = 60_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass: archive every ready, not-yet-archived time-lapse. Never throws. */
  async tick(): Promise<void> {
    let remote: RemoteTimelapse[];
    try {
      const res = await this.fetchImpl(`${this.options.baseUrl}/timelapse`);
      if (!res.ok) return;
      remote = (await res.json()) as RemoteTimelapse[];
    } catch (err) {
      this.options.log?.(`time-lapse archive: could not reach the camera service: ${String(err)}`);
      return;
    }

    for (const t of remote) {
      if (t.state !== 'ready' || this.isArchived(t.id)) continue;
      await this.archiveOne(t).catch((err: unknown) => {
        this.options.log?.(`time-lapse archive: ${t.id}: ${String(err)}`);
      });
    }
  }

  isArchived(id: string): boolean {
    return existsSync(this.videoFile(id)) && existsSync(this.metaFile(id));
  }

  private async archiveOne(t: RemoteTimelapse): Promise<void> {
    const res = await this.fetchImpl(`${this.options.baseUrl}/timelapse/${t.id}.mp4`);
    if (!res.ok || !res.body) {
      throw new Error(`download failed: ${res.status}`);
    }
    const part = `${this.videoFile(t.id)}.part`;
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(part),
    );
    renameSync(part, this.videoFile(t.id));

    const filename = this.options.history
      ? ((await this.options.history.list(500)).find((p) => p.taskId === t.id)?.filename ?? null)
      : null;
    const meta: ArchivedTimelapse = {
      id: t.id,
      frames: t.frames,
      startedAt: t.startedAt,
      ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
      bytes: statSync(this.videoFile(t.id)).size,
      filename,
    };
    writeFileSync(this.metaFile(t.id), JSON.stringify(meta));
    this.options.log?.(`time-lapse archive: ${t.id} archived (${meta.bytes} bytes)`);

    // Only now - the archive is safely on disk, so the camera service's copy
    // is no longer the only one. A failure here just means a lingering copy
    // there, cleaned up on the next tick... though the id is by then already
    // "archived" here, so nothing retries the delete on its own. Log it
    // instead: a stray file on the camera service's disk is a much smaller
    // problem than a lost time-lapse.
    await this.fetchImpl(`${this.options.baseUrl}/timelapse/${t.id}`, { method: 'DELETE' }).catch(
      (err: unknown) => {
        this.options.log?.(
          `time-lapse archive: archived ${t.id} but could not delete the camera service's copy: ${String(err)}`,
        );
      },
    );
  }

  /** Archived time-lapses, newest first. */
  list(): ArchivedTimelapse[] {
    return readdirSync(this.options.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.info(name.slice(0, -'.json'.length)))
      .filter((info): info is ArchivedTimelapse => info !== undefined)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  info(id: string): ArchivedTimelapse | undefined {
    if (!isArchiveId(id)) return undefined;
    try {
      return JSON.parse(readFileSync(this.metaFile(id), 'utf8')) as ArchivedTimelapse;
    } catch {
      return undefined;
    }
  }

  /** The archived video's path, or undefined when this id has not been archived. */
  videoPath(id: string): string | undefined {
    return isArchiveId(id) && this.isArchived(id) ? this.videoFile(id) : undefined;
  }

  /** For tests: remove an archived time-lapse and its metadata. */
  remove(id: string): void {
    rmSync(this.videoFile(id), { force: true });
    rmSync(this.metaFile(id), { force: true });
  }

  private videoFile(id: string): string {
    return join(this.options.dir, `${id}.mp4`);
  }

  private metaFile(id: string): string {
    return join(this.options.dir, `${id}.json`);
  }
}
