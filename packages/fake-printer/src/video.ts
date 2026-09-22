import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A source of JPEG frames for the fake printer's MJPEG endpoint.
 *
 * Defaults to synthetic frames so the test suite and CI need no ffmpeg and no
 * media files. Point FAKE_VIDEO at a real video and, if ffmpeg is present, the
 * frames become actual moving pictures - which is the only way to tell whether
 * the camera proxy and the <img> in the dashboard genuinely work.
 */
export interface FrameSource {
  next(): Buffer;
  readonly count: number;
  readonly synthetic: boolean;
}

export function syntheticFrames(): FrameSource {
  let n = 0;
  return {
    synthetic: true,
    count: 0,
    next() {
      n += 1;
      return Buffer.from(`fake-jpeg-frame-${n}`);
    },
  };
}

/**
 * Extract frames from a video once, up front, and then loop them.
 *
 * Decoding ahead of time rather than streaming through ffmpeg avoids having to
 * split a raw MJPEG byte stream on SOI/EOI markers, and makes the endpoint
 * cheap to serve to several viewers.
 */
export async function videoFrames(
  path: string,
  options: { fps?: number; width?: number; maxFrames?: number } = {},
): Promise<FrameSource> {
  const { fps = 4, width = 640, maxFrames = 120 } = options;
  const dir = mkdtempSync(join(tmpdir(), 'cthulhu-frames-'));

  try {
    await run('ffmpeg', [
      '-v',
      'error',
      '-i',
      path,
      '-vf',
      `fps=${fps},scale=${width}:-2`,
      '-frames:v',
      String(maxFrames),
      '-q:v',
      '6',
      join(dir, 'f%04d.jpg'),
    ]);

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      .sort();
    if (files.length === 0) throw new Error('ffmpeg produced no frames');
    const frames = files.map((f) => readFileSync(join(dir, f)));

    let i = 0;
    return {
      synthetic: false,
      count: frames.length,
      next() {
        const frame = frames[i % frames.length];
        i += 1;
        // Non-null: frames is non-empty and the index is taken modulo length.
        return frame as Buffer;
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a frame source from the environment, degrading gracefully. */
export async function frameSourceFromEnv(
  videoPath: string | undefined,
  log: (msg: string) => void = () => {},
): Promise<FrameSource> {
  if (!videoPath) return syntheticFrames();
  try {
    const source = await videoFrames(videoPath);
    log(`video: ${source.count} frames from ${videoPath}`);
    return source;
  } catch (err) {
    // A missing ffmpeg or an unreadable file must not stop the fake printer
    // starting - the rest of it is still useful.
    log(`video unavailable (${String(err).slice(0, 120)}); using synthetic frames`);
    return syntheticFrames();
  }
}
