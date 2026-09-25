import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createCameraService } from './service.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** A service whose "ffmpeg" is a stream the test writes frames into. */
async function start({ fail = false } = {}) {
  const upstreams: PassThrough[] = [];
  let aborted = 0;
  const { server, proxy } = createCameraService({
    openUpstream: async () => {
      if (fail) throw new Error('ffmpeg failed to start');
      const stream = new PassThrough();
      upstreams.push(stream);
      return { stream, abort: () => (aborted += 1) };
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return { base, proxy, upstreams, aborted: () => aborted };
}

const frame = Buffer.concat([
  Buffer.from('--frame\r\nContent-type: image/jpeg\r\n\r\n'),
  Buffer.from([0xff, 0xd8]),
  Buffer.from('JPEG'),
  Buffer.from([0xff, 0xd9, 0x0d, 0x0a]),
]);

describe('camera service', () => {
  it('serves MJPEG from a single upstream to every viewer', async () => {
    const svc = await start();
    const a = new AbortController();
    const b = new AbortController();
    const ra = await fetch(`${svc.base}/video`, { signal: a.signal });
    const rb = await fetch(`${svc.base}/video`, { signal: b.signal });

    expect(ra.headers.get('content-type')).toBe('multipart/x-mixed-replace; boundary=frame');
    expect(svc.upstreams).toHaveLength(1);

    const readerA = ra.body?.getReader();
    const readerB = rb.body?.getReader();
    svc.upstreams[0]?.write(frame);
    expect(Buffer.from((await readerA?.read())?.value ?? []).toString()).toContain('JPEG');
    expect(Buffer.from((await readerB?.read())?.value ?? []).toString()).toContain('JPEG');

    a.abort();
    b.abort();
  });

  it('stops the upstream once the last viewer has gone', async () => {
    const svc = await start();
    const a = new AbortController();
    const res = await fetch(`${svc.base}/video`, { signal: a.signal });
    const reader = res.body?.getReader();
    svc.upstreams[0]?.write(frame);
    await reader?.read();

    a.abort();
    await expect.poll(() => svc.proxy.upstreamOpen, { timeout: 2000 }).toBe(false);
    expect(svc.aborted()).toBe(1);
  });

  it('answers 502 with the reason when the upstream cannot start', async () => {
    const svc = await start({ fail: true });
    const res = await fetch(`${svc.base}/video`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('ffmpeg failed to start');
  });

  it('reports its state on /health', async () => {
    const svc = await start();
    const res = await fetch(`${svc.base}/health`);
    expect(await res.json()).toEqual({ status: 'ok', viewers: 0, upstreamOpen: false });
  });
});

describe('time-lapse routes', () => {
  it('holds the stream, saves the latest frame per layer, and assembles on finish', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { TimelapseStore } = await import('./timelapse.js');
    const { createCameraService } = await import('./service.js');
    const upstream = new PassThrough();
    let opened = 0;
    const store = new TimelapseStore({
      dir: mkdtempSync(join(tmpdir(), 'tl-svc-')),
      spawnImpl: (() => {
        throw new Error('not in this test');
      }) as never,
    });
    const { server, proxy } = createCameraService({
      timelapse: store,
      openUpstream: async () => {
        opened += 1;
        return { stream: upstream, abort: () => {} };
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });

    await fetch(`${base}/timelapse/task-7/start`, { method: 'POST' });
    expect(proxy.upstreamOpen).toBe(true);
    expect(opened).toBe(1);

    // No frame yet: refused, not saved as nothing.
    expect((await fetch(`${base}/timelapse/task-7/frame?layer=0`, { method: 'POST' })).status).toBe(
      409,
    );

    upstream.write(frame);
    await new Promise((r) => setTimeout(r, 20));
    const saved = await fetch(`${base}/timelapse/task-7/frame?layer=0`, { method: 'POST' });
    expect(await saved.json()).toMatchObject({ state: 'recording', frames: 1 });

    expect(
      (await fetch(`${base}/timelapse/../../etc/frame?layer=0`, { method: 'POST' })).status,
    ).not.toBe(200);
    expect(
      (await (await fetch(`${base}/timelapse`)).json()).map((t: { id: string }) => t.id),
    ).toEqual(['task-7']);
  });

  it('answers 500 and stays up when saving a frame throws', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { TimelapseStore } = await import('./timelapse.js');
    const { createCameraService } = await import('./service.js');
    const upstream = new PassThrough();
    let opened = 0;
    const store = new TimelapseStore({ dir: mkdtempSync(join(tmpdir(), 'tl-svc-')) });
    // What a root-owned volume did on phi.
    store.addFrame = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    const lines: string[] = [];
    const { server } = createCameraService({
      timelapse: store,
      log: (line) => lines.push(line),
      openUpstream: async () => {
        opened += 1;
        return { stream: upstream, abort: () => {} };
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });

    await fetch(`${base}/timelapse/task-9/start`, { method: 'POST' });
    upstream.write(frame);
    await new Promise((r) => setTimeout(r, 20));

    const res = await fetch(`${base}/timelapse/task-9/frame?layer=0`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(lines.some((l) => l.includes('EACCES'))).toBe(true);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    // Still the one upstream: nothing was torn down and reopened.
    expect(opened).toBe(1);
  });

  it('serves the finished video, with Range support, and plain metadata', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { TimelapseStore } = await import('./timelapse.js');
    const { createCameraService } = await import('./service.js');
    const dir = mkdtempSync(join(tmpdir(), 'tl-video-'));
    const store = new TimelapseStore({ dir });
    store.start('task-8');
    // Write the finished state directly - what finish() would leave behind -
    // so the test does not depend on ffmpeg being installed.
    writeFileSync(join(dir, 'task-8.mp4'), '0123456789');
    writeFileSync(
      join(dir, 'task-8.json'),
      JSON.stringify({
        id: 'task-8',
        state: 'ready',
        frames: 3,
        startedAt: new Date().toISOString(),
      }),
    );
    const { server } = createCameraService({
      timelapse: store,
      openUpstream: async () => ({ stream: new PassThrough(), abort: () => {} }),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });

    const whole = await fetch(`${base}/timelapse/task-8.mp4`);
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe('0123456789');

    const partial = await fetch(`${base}/timelapse/task-8.mp4`, {
      headers: { Range: 'bytes=2-4' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await partial.text()).toBe('234');

    const head = await fetch(`${base}/timelapse/task-8.mp4`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');

    const info = await fetch(`${base}/timelapse/task-8`);
    expect(await info.json()).toMatchObject({ id: 'task-8', state: 'ready' });

    expect((await fetch(`${base}/timelapse/no-such-id.mp4`)).status).toBe(404);
  });

  it('deletes a time-lapse for the server, once it has archived its own copy', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { TimelapseStore } = await import('./timelapse.js');
    const { createCameraService } = await import('./service.js');
    const dir = mkdtempSync(join(tmpdir(), 'tl-del-'));
    const store = new TimelapseStore({ dir });
    store.start('task-9');
    writeFileSync(join(dir, 'task-9.mp4'), 'MP4');
    const { server } = createCameraService({
      timelapse: store,
      openUpstream: async () => ({ stream: new PassThrough(), abort: () => {} }),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });

    const del = await fetch(`${base}/timelapse/task-9`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(store.info('task-9')).toBeUndefined();

    const again = await fetch(`${base}/timelapse/task-9`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});
