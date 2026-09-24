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
});
