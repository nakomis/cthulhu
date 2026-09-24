import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { UpstreamHandle } from './proxy.js';

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
  /**
   * A CEILING, never a target: faster sources are thinned, slower ones are
   * passed through frame for frame. The Mars 5 Ultra sends 2.7 fps.
   */
  maxFps?: number;
  /**
   * UDP receive buffer. The default lets a keyframe burst overflow it: on the
   * real printer, 8 MB cut decoder errors from 108 to 18 in ten seconds.
   */
  bufferBytes?: number;
  /** The ffmpeg binary; launchd, for one, runs without Homebrew on PATH. */
  ffmpegPath?: string;
  /** Injected in tests. */
  spawnImpl?: typeof spawn;
  onLog?: (line: string) => void;
}

export function openRtspAsMjpeg(options: RtspOptions): UpstreamHandle {
  const {
    url,
    quality = 6,
    width = 800,
    maxFps = 10,
    bufferBytes = 8 * 1024 * 1024,
    ffmpegPath = 'ffmpeg',
    spawnImpl = spawn,
    onLog,
  } = options;

  const child = spawnImpl(
    ffmpegPath,
    [
      '-loglevel',
      'error',
      // UDP first, TCP as a fallback. The Mars 5 Ultra's RTSP server only
      // speaks UDP: asked for TCP it answers "Nonmatching transport" and
      // ffmpeg gives up. mediamtx and most other servers speak both.
      '-rtsp_transport',
      'udp+tcp',
      '-buffer_size',
      String(bufferBytes),
      // The Mars 5 Ultra's RTP timestamps run about 11x fast: frames arrive
      // every ~33 ms stamped 367 ms apart (it advertises 30/11 fps). Anything
      // timed by them is wrong - the old fps=10 filter duplicated every frame
      // ~3.7 times - so stamp each frame by when it actually arrived.
      '-use_wallclock_as_timestamps',
      '1',
      '-i',
      url,
      '-f',
      'mpjpeg',
      '-q:v',
      String(quality),
      // NOT fps=N. That filter pads to a constant rate, and with UDP
      // timestamps jumping about it emitted ~2.7 duplicate JPEGs per real
      // frame, in bursts - pinning both of Luke's cores and showing the
      // browser freeze, burst, freeze. select= only ever DROPS frames, and
      // -fps_mode vfr stops the muxer inventing new ones.
      '-vf',
      // 90% of the interval: frames jitter, so waiting the full interval and
      // then for the NEXT frame lands well short of the cap (10 gave 7). The
      // comma inside gte() is escaped: unescaped, it would end the filter.
      `select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,${(0.9 / maxFps).toFixed(3)}),scale=${width}:-2`,
      '-fps_mode',
      'vfr',
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

  // Once asked to stop, ffmpeg's complaints are about being stopped - six
  // lines of "Broken pipe" as it tries to finish writing to a closed pipe.
  let stopping = false;

  child.stderr?.on('data', (d: Buffer) => {
    if (stopping) return;
    for (const raw of d.toString().split('\n')) {
      const line = raw.trim();
      if (line && !isDecoderNoise(line)) onLog?.(`ffmpeg: ${line}`);
    }
  });

  return {
    stream: child.stdout as Readable,
    abort: () => {
      stopping = true;
      if (child.exitCode != null || child.signalCode != null) return;
      // SIGTERM first: ffmpeg catches it and sends RTSP TEARDOWN, so the
      // printer stops sending UDP packets at once rather than when its
      // session times out. SIGKILL if it has not gone within two seconds -
      // a blocking read can ignore the polite signal.
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      force.unref?.();
      child.once('exit', () => clearTimeout(force));
    },
  };
}

/**
 * Chatter from the real printer's stream that is expected and harmless: the
 * H.264 decoder waiting for its first keyframe, and RTP packets lost or
 * reordered over WiFi (it is UDP). Left in, it buried Luke's log - several
 * lines a second per viewer - and any line that mattered with it.
 */
const DECODER_NOISE = [
  /non-existing PPS \d+ referenced/,
  /^Last message repeated/,
  /no frame!$/,
  /decode_slice_header error/,
  /RTP: PT=\d+: bad cseq/,
  /cabac decode of qscale diff failed/,
  /error while decoding MB/,
  /concealing \d+ DC, \d+ AC, \d+ MV errors/,
  /^\[rtsp @ 0x[0-9a-f]+\]$/,
];

export function isDecoderNoise(line: string): boolean {
  return DECODER_NOISE.some((re) => re.test(line));
}
