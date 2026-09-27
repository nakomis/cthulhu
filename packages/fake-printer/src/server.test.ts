import {
  MachineStatus,
  PrintStatus,
  type parseStatus,
  SdcpClient,
  type SocketLike,
  StartPrintError,
  UPLOAD_CHUNK_BYTES,
  UploadRejectedError,
  uploadFile,
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

describe('Cmd 255, terminating a file transfer', () => {
  it('REFUSES to send without a filename, because that crashes a real printer', async () => {
    // Not a validation nicety. Sending Cmd 255 with Uuid alone to a Mars 5
    // Ultra on firmware V1.5.0 produced no response, reset the WebSocket, and
    // took the printer's whole SDCP service down: TCP 3030, RTSP 554 and UDP
    // discovery all stopped answering while it still replied to ping. It needed
    // a power cycle. The guard in SdcpClient is the only thing between a
    // caller's undefined and a dead printer, so it is tested here rather than
    // left to a comment.
    await expect(client.terminateFileTransfer('some-uuid', '')).rejects.toThrow(/both a uuid/);
    await expect(client.terminateFileTransfer('', 'part.goo')).rejects.toThrow(/both a uuid/);
    // Nothing reached the printer at all.
    expect(printer.terminated).toEqual([]);
  });

  it('abandons a transfer that is part-way through', async () => {
    // The fake tracks partial transfers by uuid; the real printer keys its
    // reassembly on the same value, which is why the uuid and not the filename
    // identifies the transfer.
    const data = new Uint8Array(UPLOAD_CHUNK_BYTES * 3);
    const uuid = 'cancel-me-uuid';
    const controller = new AbortController();

    const upload = uploadFile({
      address: '127.0.0.1',
      port: printer.wsPort,
      filename: 'abandoned.goo',
      data,
      uuid,
      signal: controller.signal,
      onProgress: (sent) => {
        // Cancel as soon as the first packet is in, so a partial exists.
        if (sent >= UPLOAD_CHUNK_BYTES) controller.abort(new Error('cancelled'));
      },
    });

    await expect(upload).rejects.toThrow();
    expect(printer.partialUploads()).toContain(uuid);

    await client.terminateFileTransfer(uuid, 'abandoned.goo');

    expect(printer.terminated).toEqual([uuid]);
    expect(printer.partialUploads()).not.toContain(uuid);
    // A cancelled transfer must leave no file behind.
    expect(printer.uploads.has('abandoned.goo')).toBe(false);
  });

  it('acks a cancel for a transfer the printer never saw', async () => {
    // A client cancels without knowing whether any packet arrived; a cancel of
    // nothing has still achieved what was asked.
    await expect(
      client.terminateFileTransfer('never-existed', 'ghost.goo'),
    ).resolves.toBeUndefined();
  });
});

describe('confirmUploaded, waiting for a slow printer (CTHU-29)', () => {
  it('does NOT give up while the printer says it is still transferring', async () => {
    // The bug this guards, met on a real 368 MB upload: after the last packet
    // the printer finalises and MD5s the file, reporting FileTransferring
    // throughout. The old flat 30s deadline expired during that, so a
    // PERFECTLY GOOD transfer was reported as "never appeared on the printer"
    // — and the obvious response, re-uploading, costs minutes and fixes
    // nothing. A busy printer has not failed.
    printer.state.setMachineStatus(MachineStatus.FileTransferring);
    printer.pushStatus();
    await new Promise((r) => setTimeout(r, 60));

    // A deadline far shorter than the time we spend transferring.
    const verdict = client.confirmUploaded('slow.goo', { timeoutMs: 120, intervalMs: 20 });

    // Stay "transferring" for well past that deadline, pushing status as the
    // real printer does, then finish and list the file.
    for (let i = 0; i < 8; i += 1) {
      printer.pushStatus();
      await new Promise((r) => setTimeout(r, 30));
    }
    printer.state.setMachineStatus(MachineStatus.Idle);
    printer.addFile('slow.goo');
    printer.pushStatus();

    await expect(verdict).resolves.toBe('/local/slow.goo');
  });

  it('still gives up once the printer is idle and the file is absent', async () => {
    // The timeout must not become unbounded: an idle printer that is not
    // listing the file really has lost it.
    printer.state.setMachineStatus(MachineStatus.Idle);
    printer.pushStatus();
    await new Promise((r) => setTimeout(r, 60));

    await expect(
      client.confirmUploaded('missing.goo', { timeoutMs: 150, intervalMs: 25 }),
    ).rejects.toBeInstanceOf(UploadRejectedError);
  });
});
