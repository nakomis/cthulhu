import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { isDecoderNoise, openRtspAsMjpeg } from './rtsp.js';

/** A stand-in for a spawned ffmpeg, so no binary is needed. */
function fakeSpawn() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  const spawnImpl = vi.fn().mockReturnValue(child);
  return { child, spawnImpl };
}

describe('openRtspAsMjpeg', () => {
  it('invokes ffmpeg with the RTSP url and mjpeg output', () => {
    const { spawnImpl } = fakeSpawn();
    openRtspAsMjpeg({ url: 'rtsp://172.29.0.50:554/live', spawnImpl: spawnImpl as never });

    const [bin, args] = spawnImpl.mock.calls[0] as [string, string[]];
    expect(bin).toBe('ffmpeg');
    expect(args).toContain('rtsp://172.29.0.50:554/live');
    expect(args).toContain('mpjpeg');
  });

  it('tries UDP first and falls back to TCP', () => {
    // The Mars 5 Ultra only speaks RTSP over UDP and answers a TCP request
    // with "Nonmatching transport". Forcing TCP broke the real printer.
    const { spawnImpl } = fakeSpawn();
    openRtspAsMjpeg({ url: 'rtsp://x/live', spawnImpl: spawnImpl as never });

    const [, args] = spawnImpl.mock.calls[0] as [string, string[]];
    const i = args.indexOf('-rtsp_transport');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('udp+tcp');
  });

  it('puts -rtsp_transport BEFORE -i, or ffmpeg ignores it', () => {
    // An input option after -i applies to the next input, i.e. to nothing.
    const { spawnImpl } = fakeSpawn();
    openRtspAsMjpeg({ url: 'rtsp://x/live', spawnImpl: spawnImpl as never });

    const [, args] = spawnImpl.mock.calls[0] as [string, string[]];
    expect(args.indexOf('-rtsp_transport')).toBeLessThan(args.indexOf('-i'));
  });

  it('SIGTERMs on abort, so ffmpeg sends RTSP TEARDOWN', () => {
    // A SIGKILLed ffmpeg never says goodbye, and the printer keeps sending
    // UDP packets until its RTSP session times out.
    const { child, spawnImpl } = fakeSpawn();
    const handle = openRtspAsMjpeg({ url: 'rtsp://x/live', spawnImpl: spawnImpl as never });

    handle.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('SIGKILLs if ffmpeg ignores SIGTERM for two seconds', () => {
    // ffmpeg in a blocking read can ignore the polite signal.
    vi.useFakeTimers();
    try {
      const { child, spawnImpl } = fakeSpawn();
      const handle = openRtspAsMjpeg({ url: 'rtsp://x/live', spawnImpl: spawnImpl as never });

      handle.abort();
      vi.advanceTimersByTime(2000);
      expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not SIGKILL an ffmpeg that exited on SIGTERM', () => {
    vi.useFakeTimers();
    try {
      const { child, spawnImpl } = fakeSpawn();
      const handle = openRtspAsMjpeg({ url: 'rtsp://x/live', spawnImpl: spawnImpl as never });

      handle.abort();
      child.emit('exit', null, 'SIGTERM');
      vi.advanceTimersByTime(5000);
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces ffmpeg stderr through the log hook', async () => {
    const { child, spawnImpl } = fakeSpawn();
    const lines: string[] = [];
    openRtspAsMjpeg({
      url: 'rtsp://x/live',
      spawnImpl: spawnImpl as never,
      onLog: (l) => lines.push(l),
    });

    child.stderr.write('Connection refused\n');
    await new Promise((r) => setTimeout(r, 20));
    expect(lines.join()).toContain('Connection refused');
  });

  it('exposes stdout as the stream', async () => {
    const { child, spawnImpl } = fakeSpawn();
    const handle = openRtspAsMjpeg({ url: 'rtsp://x/live', spawnImpl: spawnImpl as never });

    const chunk = new Promise<Buffer>((r) => handle.stream.once('data', r));
    child.stdout.write(Buffer.from('--frame\r\n'));
    expect((await chunk).toString()).toContain('--frame');
  });

  it('ends the stream instead of crashing when ffmpeg is not installed', async () => {
    // A spawn failure is an 'error' event on the child. Unhandled, it would
    // take the whole server down; handled, the camera proxy sees the stream
    // fail and releases the printer's slot.
    const { child, spawnImpl } = fakeSpawn();
    const logs: string[] = [];
    const { stream } = openRtspAsMjpeg({
      url: 'rtsp://x/live',
      spawnImpl: spawnImpl as never,
      onLog: (l) => logs.push(l),
    });
    const failed = new Promise<Error>((r) => stream.once('error', r));

    child.emit('error', new Error('spawn ffmpeg ENOENT'));

    expect((await failed).message).toContain('ENOENT');
    expect(logs.join('\n')).toContain('ffmpeg failed to start');
  });

  it('drops expected decoder chatter but keeps real failures', () => {
    // Lines seen from the real Mars 5 Ultra over WiFi, several a second.
    for (const noise of [
      '[h264 @ 0x7f8085f06180] non-existing PPS 0 referenced',
      'Last message repeated 1 times',
      '[h264 @ 0x592404b0e600] no frame!',
      '[h264 @ 0x592404b0e600] decode_slice_header error',
      '[rtsp @ 0x5ccf8e801d40] RTP: PT=60: bad cseq 19db expected=0a32',
      '[rtsp @ 0x5ccf8e801d40]',
      'cabac decode of qscale diff failed at 26 25',
    ]) {
      expect(isDecoderNoise(noise)).toBe(true);
    }
    for (const real of [
      '[rtsp @ 0x7f] Nonmatching transport in server reply',
      'rtsp://172.29.0.37:554/video: Connection refused',
      'Error opening input files: Invalid data found when processing input',
    ]) {
      expect(isDecoderNoise(real)).toBe(false);
    }
  });

  it('stamps frames by arrival time, because the printer clock runs 11x fast', () => {
    // Frames arrive every ~33 ms stamped 367 ms apart. Timed by those stamps,
    // the old fps=10 filter duplicated each frame ~3.7 times: ~94 fps of
    // JPEGs from a 25 fps camera, both of Luke's cores pinned.
    const { spawnImpl } = fakeSpawn();
    openRtspAsMjpeg({ url: 'rtsp://x/live', spawnImpl: spawnImpl as never });
    const [, args] = spawnImpl.mock.calls[0] as [string, string[]];

    const i = args.indexOf('-use_wallclock_as_timestamps');
    expect(args[i + 1]).toBe('1');
    expect(i).toBeLessThan(args.indexOf('-i'));
  });

  it('caps the frame rate by dropping frames, never by inventing them', () => {
    const { spawnImpl } = fakeSpawn();
    openRtspAsMjpeg({ url: 'rtsp://x/live', maxFps: 20, spawnImpl: spawnImpl as never });
    const [, args] = spawnImpl.mock.calls[0] as [string, string[]];
    const filter = args[args.indexOf('-vf') + 1] as string;

    expect(filter).not.toMatch(/(^|,)fps=/);
    expect(filter).toContain('select=');
    expect(filter).toContain('0.045'); // 90% of 1/20 s
    expect(args[args.indexOf('-fps_mode') + 1]).toBe('vfr');
  });

  it('enlarges the UDP buffer, and runs whichever ffmpeg it is given', () => {
    const { spawnImpl } = fakeSpawn();
    openRtspAsMjpeg({
      url: 'rtsp://x/live',
      ffmpegPath: '/opt/homebrew/bin/ffmpeg',
      spawnImpl: spawnImpl as never,
    });
    const [bin, args] = spawnImpl.mock.calls[0] as [string, string[]];
    expect(bin).toBe('/opt/homebrew/bin/ffmpeg');
    expect(args[args.indexOf('-buffer_size') + 1]).toBe(String(8 * 1024 * 1024));
  });

  it('pins the RTP receive ports when both are given, before -i', () => {
    const { spawnImpl } = fakeSpawn();
    openRtspAsMjpeg({
      url: 'rtsp://x/live',
      rtpPortMin: 50000,
      rtpPortMax: 50009,
      spawnImpl: spawnImpl as never,
    });
    const [, args] = spawnImpl.mock.calls[0] as [string, string[]];

    expect(args[args.indexOf('-min_port') + 1]).toBe('50000');
    expect(args[args.indexOf('-max_port') + 1]).toBe('50009');
    expect(args.indexOf('-min_port')).toBeLessThan(args.indexOf('-i'));
  });

  it('leaves the RTP port range to ffmpeg by default', () => {
    const { spawnImpl } = fakeSpawn();
    openRtspAsMjpeg({ url: 'rtsp://x/live', spawnImpl: spawnImpl as never });
    const [, args] = spawnImpl.mock.calls[0] as [string, string[]];

    expect(args).not.toContain('-min_port');
    expect(args).not.toContain('-max_port');
  });

  it('ignores a port range with only one end set', () => {
    const { spawnImpl } = fakeSpawn();
    openRtspAsMjpeg({ url: 'rtsp://x/live', rtpPortMin: 50000, spawnImpl: spawnImpl as never });
    const [, args] = spawnImpl.mock.calls[0] as [string, string[]];

    expect(args).not.toContain('-min_port');
  });

  it('stays quiet about ffmpeg complaining that it was stopped', () => {
    const { child, spawnImpl } = fakeSpawn();
    const logs: string[] = [];
    const handle = openRtspAsMjpeg({
      url: 'rtsp://x/live',
      spawnImpl: spawnImpl as never,
      onLog: (l) => logs.push(l),
    });
    handle.abort();
    child.stderr.write('Error submitting a packet to the muxer: Broken pipe\n');
    expect(logs).toEqual([]);
  });
});
