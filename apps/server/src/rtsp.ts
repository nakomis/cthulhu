import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { UpstreamHandle } from './camera.js';

/**
 * Turn the printer's RTSP stream into MJPEG a browser can render.
 *
 * The official SDCP specification returns an RTSP address from Cmd 386
 * (`VideoUrl`), NOT an MJPEG endpoint. A browser cannot consume RTSP in an
 * <img>, so something has to transcode. ffmpeg is already an accepted
 * dependency here - the fake printer uses it for its video source.
 *
 * MJPEG rather than HLS or fragmented MP4 because the consumer is a single
 * <img> tag with no player, no buffering and no latency budget to speak of.
 * A print is watched to see whether it has failed, so a second of lag matters
 * more than compression does.
 */
export interface RtspOptions {
  url: string;
  /** Lower is smaller; 2-31 in ffmpeg's scale, where 2 is best quality. */
  quality?: number;
  /** Scale the long edge down; the dashboard shows it a few hundred px wide. */
  width?: number;
  fps?: number;
  /** Injected in tests. */
  spawnImpl?: typeof spawn;
  onLog?: (line: string) => void;
}

export function openRtspAsMjpeg(options: RtspOptions): UpstreamHandle {
  const { url, quality = 6, width = 800, fps = 10, spawnImpl = spawn, onLog } = options;

  const child = spawnImpl(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      // UDP first, TCP as a fallback. The Mars 5 Ultra's RTSP server only
      // speaks UDP: asked for TCP it answers "Nonmatching transport" and
      // ffmpeg gives up. mediamtx and most other servers speak both.
      '-rtsp_transport',
      'udp+tcp',
      '-i',
      url,
      '-f',
      'mpjpeg',
      '-q:v',
      String(quality),
      '-vf',
      `fps=${fps},scale=${width}:-2`,
      '-boundary_tag',
      'frame',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Without a listener, a spawn failure (ffmpeg not installed: ENOENT) is an
  // uncaught 'error' event. End the stream instead, so the proxy drops the
  // upstream and hands the printer's stream slot back.
  child.on('error', (err: Error) => {
    onLog?.(`ffmpeg failed to start: ${err.message}`);
    (child.stdout as Readable | null)?.destroy(err);
  });

  child.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) onLog?.(`ffmpeg: ${line}`);
  });

  return {
    stream: child.stdout as Readable,
    abort: () => {
      // SIGKILL rather than SIGTERM: ffmpeg reading RTSP can sit in a
      // blocking read and ignore a polite signal, and the whole point of
      // aborting is to release the printer's single stream slot promptly.
      child.kill('SIGKILL');
    },
  };
}
