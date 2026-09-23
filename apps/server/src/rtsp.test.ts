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

  it('forces RTSP over TCP', () => {
    // UDP is ffmpeg's default and loses packets over WiFi in a way that shows
    // up as a permanently corrupt picture rather than as an error.
    const { spawnImpl } = fakeSpawn();
    openRtspAsMjpeg({ url: 'rtsp://x/live', spawnImpl: spawnImpl as never });

    const [, args] = spawnImpl.mock.calls[0] as [string, string[]];
    const i = args.indexOf('-rtsp_transport');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('tcp');
  });

  it('puts -rtsp_transport BEFORE -i, or ffmpeg ignores it', () => {
    // An input option after -i applies to the next input, i.e. to nothing.
    const { spawnImpl } = fakeSpawn();
    openRtspAsMjpeg({ url: 'rtsp://x/live', spawnImpl: spawnImpl as never });

    const [, args] = spawnImpl.mock.calls[0] as [string, string[]];
    expect(args.indexOf('-rtsp_transport')).toBeLessThan(args.indexOf('-i'));
  });

  it('SIGKILLs on abort, to release the printer slot promptly', () => {
    // ffmpeg reading RTSP over TCP can sit in a blocking read and ignore
    // SIGTERM. The entire point of aborting is to free the single stream.
    const { child, spawnImpl } = fakeSpawn();
    const handle = openRtspAsMjpeg({ url: 'rtsp://x/live', spawnImpl: spawnImpl as never });

    handle.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
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
});
