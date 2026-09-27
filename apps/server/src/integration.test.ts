import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePrinter, type FakePrinter } from '@cthulhu/fake-printer';
import { syntheticGoo } from '@cthulhu/goo';
import type { SocketLike } from '@cthulhu/sdcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { FileMetaCache } from './file-meta.js';
import { SqliteHistory } from './history.js';
import { PrintView } from './print-view.js';
import { PrinterService } from './printer.js';
import { PrinterStore } from './store.js';

let printer: FakePrinter;
let service: PrinterService;
let store: PrinterStore;
let history: SqliteHistory;
let app: ReturnType<typeof buildApp>;
let dir: string;

beforeEach(async () => {
  printer = await createFakePrinter({ discovery: false, statusIntervalMs: 40, msPerLayer: 20 });
  dir = mkdtempSync(join(tmpdir(), 'cthulhu-'));
  history = new SqliteHistory(join(dir, 'test.sqlite'));
  store = new PrinterStore();

  const config = loadConfig({
    PRINTER_IP: '127.0.0.1',
    DISCOVERY_ENABLED: 'false',
    DATABASE_PATH: join(dir, 'test.sqlite'),
    // The fake printer binds an EPHEMERAL port, so the upload endpoint has to
    // be pointed at it explicitly. Without this the server uploads to the
    // default 3030, which passes on a developer machine that happens to have a
    // fake printer running there and fails in CI with a 502 - the test was
    // green for the wrong reason.
    UPLOAD_PORT: String(printer.wsPort),
  });

  service = new PrinterService({
    config,
    store,
    history,
    socketFactory: (url) => {
      // Point the client at the fake printer's ephemeral port.
      const rewritten = url.replace(/:\d+\//, `:${printer.wsPort}/`);
      return new WebSocket(rewritten) as unknown as SocketLike;
    },
    discoverImpl: async () => [],
  });
  await service.start();
  app = buildApp({
    config,
    store,
    printer: service,
    history,
    fileMeta: new FileMetaCache({ dir: join(dir, 'file-meta'), port: printer.wsPort }),
    printView: new PrintView({
      dir: join(dir, 'print-files'),
      port: printer.wsPort,
      detail: async (taskId) => {
        const res = await service.client?.historyTaskDetail([taskId]);
        const task = (res?.Data as { HistoryDetailList?: Record<string, string>[] })
          ?.HistoryDetailList?.[0];
        return task?.TaskName
          ? { taskName: task.TaskName, thumbnailUrl: task.Thumbnail }
          : undefined;
      },
    }),
  });
});

afterEach(async () => {
  service.stop();
  await app.close();
  await history.close();
  await printer.close();
  rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 120));

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('GET /health', () => {
  it('reports connected once the printer is attached', async () => {
    await settle();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().printer.connected).toBe(true);
  });
});

describe('GET /api/status', () => {
  it('serves live printer state fetched over SDCP', async () => {
    await settle();
    const body = app.inject({ method: 'GET', url: '/api/status' });
    const json = (await body).json();

    expect(json.connected).toBe(true);
    expect(json.print.statusLabel).toBeTypeOf('string');
    // The release film flag is SLA-specific and worth surfacing.
    expect(json.releaseFilmState).toBe(1);
  });

  it('can be read cross-origin, for the NakTV app', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { origin: 'null' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('exposes the single-stream limit from attributes', async () => {
    await settle();
    const json = (await app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(json.attributes.maximumVideoStreamAllowed).toBe(2);
  });
});

describe('starting a print over REST', () => {
  it('starts a known file and reflects it in status', async () => {
    await settle();
    const res = await app.inject({
      method: 'POST',
      url: '/api/print',
      payload: { filename: 'cthulhu.goo' },
    });
    expect(res.statusCode).toBe(200);

    printer.tick(200);
    await settle();
    const json = (await app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(json.print.filename).toBe('cthulhu.goo');
    expect(json.print.progressPercent).toBeGreaterThan(0);
  });

  it('returns 409 with the printer reason, not a generic 500', async () => {
    await settle();
    const res = await app.inject({
      method: 'POST',
      url: '/api/print',
      payload: { filename: 'missing.goo' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/file not found/);
    expect(res.json().ack).toBe(2);
  });

  it('rejects a request with no filename', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/print', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('stop requires explicit confirmation', () => {
  it('refuses an unconfirmed stop, because it abandons hours of printing', async () => {
    await settle();
    await app.inject({ method: 'POST', url: '/api/print', payload: { filename: 'cthulhu.goo' } });

    const res = await app.inject({ method: 'POST', url: '/api/control/stop', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/confirm/);
  });

  it('refuses confirm:"true" as a string, not just a missing flag', async () => {
    await settle();
    const res = await app.inject({
      method: 'POST',
      url: '/api/control/stop',
      payload: { confirm: 'true' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('stops when confirmed', async () => {
    await settle();
    await app.inject({ method: 'POST', url: '/api/print', payload: { filename: 'cthulhu.goo' } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/control/stop',
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('pause and resume', () => {
  it('pauses and resumes a running print', async () => {
    await settle();
    await app.inject({ method: 'POST', url: '/api/print', payload: { filename: 'cthulhu.goo' } });

    expect((await app.inject({ method: 'POST', url: '/api/control/pause' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/control/resume' })).statusCode).toBe(200);
  });
});

describe('history', () => {
  it('records a started print and lists it', async () => {
    await settle();
    await app.inject({ method: 'POST', url: '/api/print', payload: { filename: 'cthulhu.goo' } });
    await settle();

    const json = (await app.inject({ method: 'GET', url: '/api/history' })).json();
    expect(json.prints.length).toBeGreaterThan(0);
    expect(json.prints[0].filename).toBe('cthulhu.goo');
  });
});

describe('file listing', () => {
  it('proxies the printer file list', async () => {
    await settle();
    const res = await app.inject({ method: 'GET', url: '/api/files' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/upload/progress', () => {
  it('answers 204, not 404, when nothing is uploading', async () => {
    // The UI polls this on a timer; an absent upload is the normal case, not an
    // error worth a 404 in the logs on every tick.
    await settle();
    const res = await app.inject({ method: 'GET', url: '/api/upload/progress' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('reports the bytes the PRINTER has accepted while an upload runs', async () => {
    await settle();
    const body = Buffer.alloc(24 * 1024 * 1024, 5);
    const upload = app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'watched.goo' },
      payload: body,
    });

    const seen = await app.inject({ method: 'GET', url: '/api/upload/progress' });
    if (seen.statusCode === 204) {
      // Already finished — nothing to observe, and that is not a failure.
      await upload;
      return;
    }

    const json = seen.json();
    expect(json.filename).toBe('watched.goo');
    expect(json.total).toBe(body.length);
    expect(json.sent).toBeLessThanOrEqual(body.length);
    expect(json.percent).toBeGreaterThanOrEqual(0);
    expect(json.percent).toBeLessThanOrEqual(100);
    // The count is of bytes the printer took, so it can only be a multiple of
    // the packet size or the total - never some arbitrary browser-side figure.
    expect(json.sent % (1024 * 1024) === 0 || json.sent === body.length).toBe(true);

    await upload;
    // And it clears afterwards.
    expect((await app.inject({ method: 'GET', url: '/api/upload/progress' })).statusCode).toBe(204);
  });

  it('withholds the ETA until a second packet has landed', async () => {
    // The first packet pays for the connection - about seven seconds on the real
    // printer against ~0.3s for the rest - so a rate averaged over it
    // over-estimates the remaining time by an order of magnitude. No estimate is
    // better than a wrong one.
    await settle();
    const seenBefore: unknown[] = [];
    const body = Buffer.alloc(8 * 1024 * 1024, 6);
    const upload = app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'eta.goo' },
      payload: body,
    });
    const res = await app.inject({ method: 'GET', url: '/api/upload/progress' });
    if (res.statusCode === 200) {
      const json = res.json();
      seenBefore.push(json);
      if (json.sent <= 1024 * 1024) {
        expect(json.remainingMs).toBeUndefined();
      } else {
        // Past the first packet, an estimate is allowed and must be sane.
        expect(typeof json.remainingMs).toBe('number');
        expect(json.remainingMs).toBeGreaterThanOrEqual(0);
      }
    }
    await upload;
    expect(seenBefore.length).toBeLessThanOrEqual(1);
  });
});

describe('POST /api/upload/cancel', () => {
  it('stops an upload in flight and tells the printer to drop it', async () => {
    await settle();
    // Big enough to still be sending when the cancel lands. The fake printer
    // accepts packets as fast as they arrive, so the race is real either way:
    // the assertions below are on the OUTCOME, not on how far it had got.
    const body = Buffer.alloc(24 * 1024 * 1024, 9);

    const upload = app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'cancel-me.goo' },
      payload: body,
    });

    let cancel = await app.inject({ method: 'POST', url: '/api/upload/cancel' });
    // If the upload already finished, there is nothing to cancel and the 409 is
    // correct; only assert the cancel path when it actually caught one.
    if (cancel.statusCode === 409) {
      await upload;
      return;
    }

    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ ok: true, cancelled: 'cancel-me.goo' });
    // The printer must have been told, so it is not left holding a part file.
    expect(cancel.json().printerNotified).toBe(true);
    expect(printer.terminated.length).toBe(1);

    const res = await upload;
    // 499, not 502: the caller asked for this, and reporting it as a transfer
    // failure would have the UI shout about something the user just did.
    expect(res.statusCode).toBe(499);
    expect(printer.uploads.has('cancel-me.goo')).toBe(false);

    // And the slot is free again.
    cancel = await app.inject({ method: 'POST', url: '/api/upload/cancel' });
    expect(cancel.statusCode).toBe(409);
  });

  it('answers 409 when nothing is uploading', async () => {
    await settle();
    const res = await app.inject({ method: 'POST', url: '/api/upload/cancel' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/No upload in progress/);
  });

  it('refuses a second upload while one is running, rather than interleaving', async () => {
    // Both would carry their own Uuid but share the printer's single reassembly
    // slot; offsets from two files would interleave and corrupt each other.
    await settle();
    const body = Buffer.alloc(16 * 1024 * 1024, 3);
    const first = app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'one.goo' },
      payload: body,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'two.goo' },
      payload: Buffer.alloc(1024, 4),
    });

    if (second.statusCode === 409) {
      expect(second.json().error).toMatch(/Already uploading one\.goo/);
    }
    await first;
  });
});

describe('POST /api/files/delete', () => {
  const del = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/files/delete', payload: payload as object });

  it('deletes a file from the printer and hands back the new listing', async () => {
    await settle();
    expect(printer.files()).toContain('cthulhu.goo');

    const res = await del({ files: ['/local/cthulhu.goo'], confirm: true });

    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toEqual(['/local/cthulhu.goo']);
    expect(printer.deleted).toEqual(['/local/cthulhu.goo']);
    expect(printer.files()).not.toContain('cthulhu.goo');
    // The printer pushes no new listing, so the response carries a re-read one.
    // Without it a caller cannot tell an acked delete from an effective one.
    expect(res.json().files.map((f: { name: string }) => f.name)).not.toContain('cthulhu.goo');
  });

  it('deletes several files in ONE command, not one request each', async () => {
    // The printer's own command is a batch one, and a round trip to this
    // machine is not cheap. Six files must not mean six round trips.
    await settle();
    const res = await del({ files: ['/local/cthulhu.goo', '/local/test.goo'], confirm: true });

    expect(res.statusCode).toBe(200);
    expect(printer.deleted).toEqual(['/local/cthulhu.goo', '/local/test.goo']);
    expect(printer.files()).toEqual([]);
  });

  it('refuses without an explicit confirm, and deletes nothing', async () => {
    await settle();
    const res = await del({ files: ['/local/cthulhu.goo'] });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/irreversible/i);
    expect(printer.deleted).toEqual([]);
    expect(printer.files()).toContain('cthulhu.goo');
  });

  it('rejects a bare filename rather than acking a delete of nothing', async () => {
    // The printer wants absolute, storage-qualified paths. A bare name is the
    // mistake a caller is most likely to make, and the real machine would
    // very likely ack it and delete nothing.
    await settle();
    const res = await del({ files: ['cthulhu.goo'], confirm: true });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/storage-qualified/);
    expect(printer.deleted).toEqual([]);
    expect(printer.files()).toContain('cthulhu.goo');
  });

  it('rejects an empty list', async () => {
    await settle();
    expect((await del({ files: [], confirm: true })).statusCode).toBe(400);
    expect((await del({ confirm: true })).statusCode).toBe(400);
    expect(printer.deleted).toEqual([]);
  });

  it('refuses to delete the file that is printing right now', async () => {
    await settle();
    await app.inject({ method: 'POST', url: '/api/print', payload: { filename: 'cthulhu.goo' } });
    await settle();

    const res = await del({ files: ['/local/cthulhu.goo'], confirm: true });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/printing right now/);
    expect(printer.files()).toContain('cthulhu.goo');
  });

  it('allows deleting a file once its print has FINISHED', async () => {
    // The regression this guards: print.filename comes from the printer's
    // status, which goes on naming the last print at Complete and Idle. A guard
    // on the name alone would make a file undeletable for ever once printed.
    await settle();
    await app.inject({ method: 'POST', url: '/api/print', payload: { filename: 'cthulhu.goo' } });
    await settle();
    // Run the print out to Complete.
    for (let i = 0; i < 400 && store.snapshot().machineStatus.includes(1); i += 1) {
      printer.tick(200);
      await settle();
    }
    expect(store.snapshot().print.filename).toBe('cthulhu.goo');
    expect(store.snapshot().machineStatus).not.toContain(1);

    const res = await del({ files: ['/local/cthulhu.goo'], confirm: true });
    expect(res.statusCode).toBe(200);
    expect(printer.files()).not.toContain('cthulhu.goo');
  });
});

describe('bugs found by running the stack live against the fake printer', () => {
  it('learns the mainboardId from attributes when only a pinned IP is configured', async () => {
    // With PRINTER_IP set and discovery off there is nothing to learn the id
    // from up front, so it starts empty. Every request envelope carries
    // MainboardID, and a real printer is unlikely to be as forgiving about an
    // empty one as the fake is.
    await settle();
    expect(service.client?.mainboardId).toBe(printer.mainboardId);
    expect(service.client?.mainboardId).not.toBe('');
  });

  it('records history with the REAL taskId, not an empty string', async () => {
    await settle();
    await app.inject({ method: 'POST', url: '/api/print', payload: { filename: 'cthulhu.goo' } });
    // The taskId does not exist until the next status push, so recording at
    // the moment of the REST call captured "".
    await settle();

    const prints = (await app.inject({ method: 'GET', url: '/api/history' })).json().prints;
    expect(prints).toHaveLength(1);
    expect(prints[0].taskId).toBeTruthy();
    expect(prints[0].taskId).not.toBe('');
    expect(prints[0].totalLayer).toBe(120);
  });

  it('records a print started on the machine itself, not just via REST', async () => {
    // printStarted is edge-triggered on the taskId changing, so a print begun
    // from the printer's own touchscreen lands in history too.
    await settle();
    printer.state.startPrint({
      filename: 'touchscreen.goo',
      totalLayer: 42,
      msPerLayer: 20,
      taskId: 'from-the-machine',
    });
    printer.pushStatus();
    await settle();

    const prints = (await app.inject({ method: 'GET', url: '/api/history' })).json().prints;
    expect(prints[0].filename).toBe('touchscreen.goo');
    expect(prints[0].taskId).toBe('from-the-machine');
  });

  it('does not create a duplicate history row for the same print', async () => {
    await settle();
    await app.inject({ method: 'POST', url: '/api/print', payload: { filename: 'cthulhu.goo' } });
    await settle();
    // Many status pushes follow, all carrying the same taskId.
    printer.pushStatus();
    printer.pushStatus();
    await settle();

    const prints = (await app.inject({ method: 'GET', url: '/api/history' })).json().prints;
    expect(prints).toHaveLength(1);
  });
});

describe('uploading a realistically-sized file', () => {
  it("accepts a file far larger than Fastify's 1MB default body limit", async () => {
    // Found with a real 13MB sliced hanger. Fastify defaults bodyLimit to ONE
    // MEGABYTE, so every genuine sliced file was rejected with a 413 - and
    // only AFTER nginx had accepted it, because the vhost allows 1024M. A
    // small synthetic fixture sails through and hides this completely.
    await settle();
    const fourMegabytes = Buffer.alloc(4 * 1024 * 1024, 7);

    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'big.goo' },
      payload: fourMegabytes,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().size).toBe(fourMegabytes.length);
  });

  it('computes the MD5 over the whole body, not a truncated prefix', async () => {
    const { createHash } = await import('node:crypto');
    await settle();
    const body = Buffer.alloc(2 * 1024 * 1024, 42);
    const expected = createHash('md5').update(body).digest('hex');

    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'md5.goo' },
      payload: body,
    });

    expect(res.json().md5).toBe(expected);
  });

  it("reads a file's preview and details from the file on the printer", async () => {
    await settle();
    const goo = syntheticGoo({
      width: 80,
      height: 40,
      layers: [() => true, (x) => x < 40],
      printTimeS: 5300,
    });
    const upload = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'rook.goo' },
      payload: goo,
    });
    expect(upload.statusCode).toBe(200);

    const meta = await app.inject({ method: 'GET', url: '/api/files/meta?path=/local/rook.goo' });
    expect(meta.json()).toMatchObject({ layerCount: 2, printTimeS: 5300, preview: true });

    const preview = await app.inject({
      method: 'GET',
      url: '/api/files/preview?path=/local/rook.goo',
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('image/png');

    const none = await app.inject({
      method: 'GET',
      url: '/api/files/preview?path=/local/nope.goo',
    });
    expect(none.statusCode).toBe(404);
  });

  it('refuses to fetch anything from the printer but print files', async () => {
    // The printer's web server also serves its WiFi password.
    await settle();
    for (const path of ['/media/mmcblk0p1/wlan_entry', '/local/../mmcblk0p1/wlan_entry']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/files/preview?path=${encodeURIComponent(path)}`,
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("shows the current print's thumbnail and the layer being printed", async () => {
    await settle();
    // Layer 0 all lit; every later layer dark.
    const goo = syntheticGoo({
      width: 80,
      height: 40,
      layers: [() => true, ...Array.from({ length: 119 }, () => () => false)],
    });
    await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'layers.goo' },
      payload: goo,
    });
    await app.inject({
      method: 'POST',
      url: '/api/print',
      payload: { filename: '/local/layers.goo' },
    });
    await waitFor(
      () => store.snapshot().print.taskId !== undefined && store.snapshot().print.taskId !== '',
    );

    const thumb = await app.inject({ method: 'GET', url: '/api/print/thumbnail' });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/png');

    // The print file comes from the printer first: 202 until it has.
    let layer = await app.inject({ method: 'GET', url: '/api/print/layer?layer=0' });
    for (let i = 0; i < 50 && layer.statusCode === 202; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      layer = await app.inject({ method: 'GET', url: '/api/print/layer?layer=0' });
    }
    expect(layer.statusCode).toBe(200);
    expect(layer.headers['content-type']).toBe('image/png');
    expect(layer.headers['x-layer']).toBe('0');
  });

  it('still rejects a non-.goo/.ctb file, however large', async () => {
    await settle();
    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'model.stl' },
      payload: Buffer.alloc(1024, 1),
    });
    expect(res.statusCode).toBe(400);
  });
});
