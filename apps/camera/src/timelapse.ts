import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type TimelapseState = 'recording' | 'assembling' | 'ready' | 'failed';

export interface TimelapseInfo {
  id: string;
  state: TimelapseState;
  frames: number;
  startedAt: string;
  finishedAt?: string;
  /** Size of the finished video. */
  bytes?: number;
  error?: string;
}

export interface TimelapseStoreOptions {
  dir: string;
  ffmpegPath?: string;
  /** Frames per second of the finished video: 30 makes 900 layers 30 s. */
  fps?: number;
  /** Injected in tests. */
  spawnImpl?: typeof spawn;
  log?: (line: string) => void;
}

/** Task ids are UUIDs; nothing else becomes a path. */
const ID = /^[A-Za-z0-9-]{1,64}$/;
export const isTimelapseId = (id: string) => ID.test(id);

/**
 * Time-lapse frames on disk, and the videos made from them.
 *
 *   <dir>/<id>.json   what is known about it - survives a restart mid-print
 *   <dir>/<id>/       one JPEG per layer while recording, named by layer
 *   <dir>/<id>.mp4    the finished video; the frames are deleted once it exists
 */
export class TimelapseStore {
  private readonly options: TimelapseStoreOptions;

  constructor(options: TimelapseStoreOptions) {
    this.options = options;
    mkdirSync(options.dir, { recursive: true });
  }

  start(id: string): TimelapseInfo {
    const existing = this.info(id);
    if (existing) return existing;
    mkdirSync(this.framesDir(id), { recursive: true });
    return this.save({ id, state: 'recording', frames: 0, startedAt: new Date().toISOString() });
  }

  addFrame(id: string, layer: number, jpeg: Buffer): TimelapseInfo {
    const info = this.info(id) ?? this.start(id);
    if (info.state !== 'recording') return info;
    mkdirSync(this.framesDir(id), { recursive: true });
    // Zero-padded, so the frames sort into print order by name.
    writeFileSync(join(this.framesDir(id), `${String(layer).padStart(6, '0')}.jpg`), jpeg);
    return this.save({ ...info, frames: this.countFrames(id) });
  }

  /** Assemble the video. Resolves when ffmpeg has finished, one way or the other. */
  async finish(id: string): Promise<TimelapseInfo> {
    const info = this.info(id);
    if (info?.state !== 'recording') return info ?? this.fail(id, 'No such time-lapse');
    if (this.countFrames(id) === 0) return this.fail(id, 'No frames were captured');
    this.save({ ...info, state: 'assembling' });

    const out = this.videoFile(id);
    const part = `${out}.part.mp4`;
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const child = spawnImpl(
      this.options.ffmpegPath ?? 'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-framerate',
        String(this.options.fps ?? 30),
        // A glob, not %06d: a missed layer leaves a gap in the numbering,
        // which a sequence pattern would stop at.
        '-pattern_type',
        'glob',
        '-i',
        join(this.framesDir(id), '*.jpg'),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        // Even dimensions for H.264, and limited-range yuv420p for browsers -
        // converted in the filter chain, because -pix_fmt alone leaves the
        // JPEGs' full-range yuvj420p as it is, which Safari may refuse.
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=tv,format=yuv420p',
        '-pix_fmt',
        'yuv420p',
        // The index at the front, so a browser can start playing at once.
        '-movflags',
        '+faststart',
        part,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        stderr += String(err);
        resolve(-1);
      });
      child.on('close', resolve);
    });
    if (code !== 0) {
      rmSync(part, { force: true });
      return this.fail(id, `ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`);
    }
    renameSync(part, out);
    rmSync(this.framesDir(id), { recursive: true, force: true });
    const done = this.save({
      ...(this.info(id) as TimelapseInfo),
      state: 'ready',
      finishedAt: new Date().toISOString(),
      bytes: statSync(out).size,
    });
    this.options.log?.(`time-lapse ${id}: ${done.frames} frames, ${done.bytes} bytes`);
    return done;
  }

  info(id: string): TimelapseInfo | undefined {
    if (!isTimelapseId(id)) return undefined;
    try {
      return JSON.parse(readFileSync(this.metaPath(id), 'utf8')) as TimelapseInfo;
    } catch {
      return undefined;
    }
  }

  list(): TimelapseInfo[] {
    return readdirSync(this.options.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.info(name.slice(0, -'.json'.length)))
      .filter((info): info is TimelapseInfo => info !== undefined)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  videoPath(id: string): string | undefined {
    return this.info(id)?.state === 'ready' ? this.videoFile(id) : undefined;
  }

  /**
   * Delete a finished time-lapse: its video, metadata and any leftover
   * frames. Called once the server has archived a copy to the share, so the
   * camera service does not keep a second copy forever - see CTHU-16.
   * Returns whether there was anything to delete.
   */
  remove(id: string): boolean {
    if (!isTimelapseId(id)) return false;
    const existed = this.info(id) !== undefined;
    rmSync(this.videoFile(id), { force: true });
    rmSync(this.metaPath(id), { force: true });
    rmSync(this.framesDir(id), { recursive: true, force: true });
    return existed;
  }

  private fail(id: string, error: string): TimelapseInfo {
    this.options.log?.(`time-lapse ${id}: ${error}`);
    const info = this.info(id) ?? { id, frames: 0, startedAt: new Date().toISOString() };
    return this.save({ ...info, state: 'failed', error });
  }

  private countFrames(id: string): number {
    try {
      return readdirSync(this.framesDir(id)).filter((n) => n.endsWith('.jpg')).length;
    } catch {
      return 0;
    }
  }

  private framesDir(id: string): string {
    return join(this.options.dir, id);
  }

  private videoFile(id: string): string {
    return join(this.options.dir, `${id}.mp4`);
  }

  private metaPath(id: string): string {
    return join(this.options.dir, `${id}.json`);
  }

  private save(info: TimelapseInfo): TimelapseInfo {
    if (!isTimelapseId(info.id)) throw new Error(`Not a time-lapse id: ${info.id}`);
    writeFileSync(this.metaPath(info.id), JSON.stringify(info));
    return info;
  }
}
