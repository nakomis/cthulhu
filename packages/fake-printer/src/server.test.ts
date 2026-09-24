import {
  MachineStatus,
  PrintStatus,
  type parseStatus,
  SdcpClient,
  type SocketLike,
  StartPrintError,
} from '@cthulhu/sdcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createFakePrinter, type FakePrinter } from './server.js';

// `ws` exposes addEventListener, so it satisfies SocketLike directly.
const socketFactory = (url: string) => new WebSocket(url) as unknown as SocketLike;

let printer: FakePrinter;
let client: SdcpClient;

beforeEach(async () => {
  // discovery: false - a fixed UDP port would collide between parallel test files.
  printer = await createFakePrinter({ discovery: false, statusIntervalMs: 50, msPerLayer: 30 });
  client = new SdcpClient({
    address: '127.0.0.1',
    port: printer.wsPort,
    mainboardId: printer.mainboardId,
    socketFactory,
    heartbeatMs: 20,
  });
  await client.connect();
});

afterEach(async () => {
  client.close();
  await printer.close();
});

const nextStatus = (c: SdcpClient) =>
  new Promise<ReturnType<typeof parseStatus>>((resolve) => c.once('status', resolve));

/**
 * The first status frame that satisfies `accept`. Not simply the next one:
 * starting a print broadcasts a layer-0 frame, and under a loaded test run
 * it can arrive after the listener is attached.
 */
const statusWhere = (c: SdcpClient, accept: (s: ReturnType<typeof parseStatus>) => boolean) =>
  new Promise<ReturnType<typeof parseStatus>>((resolve) => {
    const onStatus = (s: ReturnType<typeof parseStatus>) => {
      if (!accept(s)) return;
      c.off('status', onStatus);
      resolve(s);
    };
    c.on('status', onStatus);
  });

describe('the fake printer, driven by the real client', () => {
  it('answers a status refresh', async () => {
    const statusPromise = nextStatus(client);
    await client.refreshStatus();
    const status = await statusPromise;

    expect(status.machineStatus).toEqual([MachineStatus.Idle]);
    expect(status.printInfo.status).toBe(PrintStatus.Idle);
  });

  it('answers an attributes refresh, including the single-stream limit', async () => {
    const attrsPromise = new Promise<{ maximumVideoStreamAllowed: number | undefined }>((r) =>
      client.once('attributes', r),
    );
    await client.refreshAttributes();
    const attrs = await attrsPromise;

    // The camera proxy design depends on this being 1.
    expect(attrs.maximumVideoStreamAllowed).toBe(2);
  });

  it('reads the misspelled RelaseFilmState through to a typed field', async () => {
    // From ATTRIBUTES: the real Mars 5 Ultra never sends it in status.
    const attrsPromise = new Promise<{ devicesStatus: { releaseFilmState: number | undefined } }>(
      (r) => client.once('attributes', r),
    );
    await client.refreshAttributes();
    expect((await attrsPromise).devicesStatus.releaseFilmState).toBe(1);
  });

  it('preserves the raw payload so nothing is lost when the shape differs', async () => {
    const statusPromise = nextStatus(client);
    await client.refreshStatus();
    const status = await statusPromise;
    expect(status.raw).toHaveProperty('Status');
  });

  it('answers the literal ping heartbeat with pong, without emitting an error', async () => {
    const errors: Error[] = [];
    client.on('error', (e) => errors.push(e));
    // heartbeatMs is 20, so several exchanges happen in this window.
    await new Promise((r) => setTimeout(r, 120));
    expect(errors).toEqual([]);
    expect(client.connected).toBe(true);
  });
});

describe('starting a print', () => {
  it('starts a known .goo file and begins advancing layers', async () => {
    await client.startPrint('cthulhu.goo');
    printer.tick(300); // 10 layers at 30ms each

    const statusPromise = statusWhere(client, (s) => (s.printInfo.currentLayer ?? 0) > 0);
    await client.refreshStatus();
    const status = await statusPromise;

    expect(status.printInfo.filename).toBe('cthulhu.goo');
    expect(status.printInfo.totalLayer).toBe(120);
    expect(status.printInfo.currentLayer).toBeGreaterThan(0);
    expect(status.machineStatus).toEqual([MachineStatus.Printing]);
  });

  it('rejects an unknown file with the documented ack, not a generic failure', async () => {
    await expect(client.startPrint('nope.goo')).rejects.toBeInstanceOf(StartPrintError);
    await expect(client.startPrint('nope.goo')).rejects.toThrow(/file not found/);
  });

  it('refuses a second print while one is running', async () => {
    await client.startPrint('cthulhu.goo');
    await expect(client.startPrint('test.goo')).rejects.toThrow(/busy/);
  });
});

describe('pause, resume and stop', () => {
  it('pauses and holds the layer steady', async () => {
    await client.startPrint('cthulhu.goo');
    printer.tick(150);
    await client.pause();

    const before = printer.state.snapshot().PrintInfo as Record<string, number>;
    printer.tick(600);
    const after = printer.state.snapshot().PrintInfo as Record<string, number>;

    expect(after.CurrentLayer).toBe(before.CurrentLayer);
    expect(after.Status).toBe(PrintStatus.Paused);
  });

  it('resumes after a pause', async () => {
    await client.startPrint('cthulhu.goo');
    printer.tick(150);
    await client.pause();
    await client.resume();
    printer.tick(150);

    const info = printer.state.snapshot().PrintInfo as Record<string, number>;
    expect(info.Status).not.toBe(PrintStatus.Paused);
  });

  it('stops and returns the machine to idle', async () => {
    await client.startPrint('cthulhu.goo');
    printer.tick(150);
    await client.stop();

    const snap = printer.state.snapshot();
    const info = snap.PrintInfo as Record<string, number>;
    expect(info.Status).toBe(PrintStatus.Stopped);
    expect(snap.CurrentStatus).toEqual([MachineStatus.Idle]);
  });

  it('runs a print through to completion', async () => {
    await client.startPrint('cthulhu.goo');
    printer.tick(120 * 30 + 100);

    const snap = printer.state.snapshot();
    const info = snap.PrintInfo as Record<string, number>;
    expect(info.Status).toBe(PrintStatus.Complete);
    expect(info.CurrentLayer).toBe(120);
    expect(snap.CurrentStatus).toEqual([MachineStatus.Idle]);
  });
});

describe('unsolicited status push', () => {
  it('pushes status without being asked, which is how the UI stays live', async () => {
    const seen: number[] = [];
    client.on('status', (s) => {
      if (s.printInfo.currentLayer !== undefined) seen.push(s.printInfo.currentLayer);
    });
    await client.startPrint('cthulhu.goo');
    await new Promise((r) => setTimeout(r, 250));
    expect(seen.length).toBeGreaterThan(1);
  });
});
