import { createFakePrinter, type FakePrinter } from '@cthulhu/fake-printer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CameraProxy } from './proxy.js';

let printer: FakePrinter;
let proxy: CameraProxy;

/** Open the fake printer's MJPEG endpoint the way the real server does. */
async function openUpstream(port: number) {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/video`, { signal: controller.signal });
  if (!res.ok || !res.body) {
    controller.abort();
    throw new Error(`Camera upstream returned ${res.status}`);
  }
  const { Readable } = await import('node:stream');
  return {
    stream: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    abort: () => controller.abort(),
  };
}

/** Can something other than us (the Elegoo app) get the single slot? */
async function slotIsFree(port: number): Promise<boolean> {
  const controller = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/video`, { signal: controller.signal });
    const ok = res.ok;
    controller.abort();
    return ok;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  printer = await createFakePrinter({ discovery: false, statusIntervalMs: 1000 });
});

afterEach(async () => {
  await proxy?.close();
  await printer.close();
});

describe('camera proxy against a printer that allows exactly one stream', () => {
  it('serves two viewers from a single upstream connection', async () => {
    proxy = new CameraProxy({ openUpstream: () => openUpstream(printer.wsPort) });

    const a = await proxy.addViewer();
    const b = await proxy.addViewer();
    expect(proxy.viewerCount).toBe(2);
    expect(proxy.upstreamOpen).toBe(true);

    const chunkA = await new Promise<Buffer>((r) => a.once('data', r));
    const chunkB = await new Promise<Buffer>((r) => b.once('data', r));
    expect(chunkA.length).toBeGreaterThan(0);
    expect(chunkB.length).toBeGreaterThan(0);
  });

  it('proves the printer really does refuse a second direct viewer', async () => {
    // A control: if this ever passes, the test above proves nothing, because
    // multiplexing would not actually be required.
    proxy = new CameraProxy({ openUpstream: () => openUpstream(printer.wsPort) });
    await proxy.addViewer();
    expect(await slotIsFree(printer.wsPort)).toBe(false);
  });

  it('RELEASES the printer slot once the last viewer leaves', async () => {
    // The whole point: holding the only slot idle means the Elegoo app can
    // never connect. Destroying the Readable is NOT enough - the underlying
    // fetch keeps the socket open - so the upstream handle must abort().
    proxy = new CameraProxy({ openUpstream: () => openUpstream(printer.wsPort) });

    const viewer = await proxy.addViewer();
    expect(proxy.upstreamOpen).toBe(true);
    expect(await slotIsFree(printer.wsPort)).toBe(false);

    viewer.destroy();
    await new Promise((r) => setTimeout(r, 300));

    expect(proxy.viewerCount).toBe(0);
    expect(proxy.upstreamOpen).toBe(false);
    expect(await slotIsFree(printer.wsPort)).toBe(true);
  });

  it('opens only ONE upstream when two viewers arrive at once', async () => {
    // Racing viewers must not each open a connection; the second would be
    // refused by the printer and that viewer would get nothing.
    let opens = 0;
    proxy = new CameraProxy({
      openUpstream: async () => {
        opens += 1;
        return openUpstream(printer.wsPort);
      },
    });

    await Promise.all([proxy.addViewer(), proxy.addViewer()]);
    expect(opens).toBe(1);
  });

  it('works a SECOND time: onActive re-enables what onIdle turned off', async () => {
    // Found by clicking Watch, Stop, then Watch again in the browser. onIdle
    // sends Cmd 386 to disable the stream; without a matching enable on the
    // way back in, the camera works exactly once and is refused forever after.
    const calls: string[] = [];
    proxy = new CameraProxy({
      openUpstream: () => openUpstream(printer.wsPort),
      onActive: () => {
        calls.push('active');
      },
      onIdle: () => {
        calls.push('idle');
      },
    });

    const first = await proxy.addViewer();
    first.destroy();
    await new Promise((r) => setTimeout(r, 300));

    const second = await proxy.addViewer();
    expect(proxy.upstreamOpen).toBe(true);
    const chunk = await new Promise<Buffer>((r) => second.once('data', r));
    expect(chunk.length).toBeGreaterThan(0);
    expect(calls).toEqual(['active', 'idle', 'active']);
  });

  it('calls onIdle so the server can send Cmd 386 and stop the stream', async () => {
    let idled = 0;
    proxy = new CameraProxy({
      openUpstream: () => openUpstream(printer.wsPort),
      onIdle: () => {
        idled += 1;
      },
    });

    const viewer = await proxy.addViewer();
    viewer.destroy();
    await new Promise((r) => setTimeout(r, 300));
    expect(idled).toBe(1);
  });

  it('calls onIdle when the upstream DIES, not only when viewers leave', async () => {
    // Found on the real printer: ffmpeg was missing from the image, so every
    // Watch died at once - and each one left a stream enabled on the printer,
    // until it refused the camera outright with "maximum streams".
    const { PassThrough } = await import('node:stream');
    const upstream = new PassThrough();
    let idled = 0;
    proxy = new CameraProxy({
      openUpstream: async () => ({ stream: upstream, abort: () => {} }),
      onIdle: () => {
        idled += 1;
      },
    });

    const viewer = await proxy.addViewer();
    const ended = new Promise((r) => viewer.once('end', r));
    viewer.resume();
    upstream.destroy(new Error('ffmpeg failed to start: spawn ffmpeg ENOENT'));
    await ended;

    expect(proxy.upstreamOpen).toBe(false);
    expect(idled).toBe(1);
  });
});
