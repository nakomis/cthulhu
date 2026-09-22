import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePrinter, type FakePrinter } from '@cthulhu/fake-printer';
import type { SocketLike } from '@cthulhu/sdcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { History } from './history.js';
import { PrinterService } from './printer.js';
import { PrinterStore } from './store.js';

let printer: FakePrinter;
let service: PrinterService;
let store: PrinterStore;
let history: History;
let app: ReturnType<typeof buildApp>;
let dir: string;

beforeEach(async () => {
  printer = await createFakePrinter({ discovery: false, statusIntervalMs: 40, msPerLayer: 20 });
  dir = mkdtempSync(join(tmpdir(), 'cthulhu-'));
  history = new History(join(dir, 'test.sqlite'));
  store = new PrinterStore();

  const config = loadConfig({
    PRINTER_IP: '127.0.0.1',
    DISCOVERY_ENABLED: 'false',
    DATABASE_PATH: join(dir, 'test.sqlite'),
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
  app = buildApp({ config, store, printer: service, history });
});

afterEach(async () => {
  service.stop();
  await app.close();
  history.close();
  await printer.close();
  rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 120));

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

  it('exposes the single-stream limit from attributes', async () => {
    await settle();
    const json = (await app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(json.attributes.maximumVideoStreamAllowed).toBe(1);
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
