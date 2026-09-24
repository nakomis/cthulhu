import { openRtspAsMjpeg } from '@cthulhu/camera';
import { createCameraService } from './service.js';
import { TimelapseStore } from './timelapse.js';

/**
 * Configuration, all from the environment:
 *
 *   PRINTER_IP    the printer; its stream is rtsp://PRINTER_IP:554/video
 *   RTSP_URL      or the stream's address in full, overriding PRINTER_IP
 *   PORT          default 9121 (cthulhu is 9120)
 *   HOST          default 0.0.0.0
 *   MAX_FPS       frame-rate ceiling, default 20 - about all the camera sends
 *   WIDTH         output width in px, default 960
 *   QUALITY       ffmpeg JPEG quality, 2 (best) to 31, default 5
 *   FFMPEG_PATH   default "ffmpeg"; launchd runs without Homebrew on PATH
 *   TIMELAPSE_DIR where time-lapse frames and videos go; unset = no time-lapses
 *   TIMELAPSE_FPS frames per second of a finished time-lapse, default 30
 *   RTP_PORT_MIN, RTP_PORT_MAX
 *                 a fixed range of local UDP ports for ffmpeg's RTP receive -
 *                 both or neither. Needed in Docker Desktop on macOS, where a
 *                 bridged container's RTP ports must be published by number
 *                 to be reachable at all; harmless (and unnecessary) under
 *                 Linux host networking. See rtsp.ts.
 */
function main(): void {
  const env = process.env;
  const url = env.RTSP_URL || (env.PRINTER_IP ? `rtsp://${env.PRINTER_IP}:554/video` : '');
  if (!url) {
    process.stderr.write('Set PRINTER_IP (or RTSP_URL).\n');
    process.exitCode = 2;
    return;
  }
  const num = (v: string | undefined, fallback: number) => Number(v) || fallback;
  const port = num(env.PORT, 9121);
  const host = env.HOST || '0.0.0.0';
  const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

  // Both or neither: a range with only one end is not a range.
  const rtpPortMin = env.RTP_PORT_MIN ? Number(env.RTP_PORT_MIN) : undefined;
  const rtpPortMax = env.RTP_PORT_MAX ? Number(env.RTP_PORT_MAX) : undefined;

  const timelapse = env.TIMELAPSE_DIR
    ? new TimelapseStore({
        dir: env.TIMELAPSE_DIR,
        fps: num(env.TIMELAPSE_FPS, 30),
        ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
        log,
      })
    : undefined;

  const { server } = createCameraService({
    log,
    ...(timelapse ? { timelapse } : {}),
    openUpstream: async () =>
      openRtspAsMjpeg({
        url,
        maxFps: num(env.MAX_FPS, 20),
        width: num(env.WIDTH, 960),
        quality: num(env.QUALITY, 5),
        ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
        ...(rtpPortMin !== undefined && rtpPortMax !== undefined ? { rtpPortMin, rtpPortMax } : {}),
        onLog: log,
      }),
  });

  server.listen(port, host, () => log(`camera service on http://${host}:${port}/video for ${url}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

main();
