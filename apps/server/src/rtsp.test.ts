import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { openRtspAsMjpeg } from './rtsp.js';

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
});
