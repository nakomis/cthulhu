import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePrinter, type FakePrinter } from '@cthulhu/fake-printer';
import type { SocketLike } from '@cthulhu/sdcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadConfig } from './config.js';
import { SqliteHistory } from './history.js';
import { PrinterService } from './printer.js';
import { PrinterStore } from './store.js';

// CTHU-20: a print cthulhu first sees once it has already finished - the
// server was down, or not yet started, while it ran - left no history row,
// because printStarted ignores terminal states and printFinished only fires
// on a transition it witnessed.

let printer: FakePrinter;
let history: SqliteHistory;
let dir: string;
const services: PrinterService[] = [];

beforeEach(async () => {
  printer = await createFakePrinter({ discovery: false, statusIntervalMs: 40, msPerLayer: 20 });
  dir = mkdtempSync(join(tmpdir(), 'cthulhu-first-sight-'));
  history = new SqliteHistory(join(dir, 'test.sqlite'));
});

afterEach(async () => {
  for (const s of services.splice(0)) s.stop();
  await history.close();
  await printer.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh server process, as far as the printer and history can tell. */
async function startServer(): Promise<PrinterService> {
  const service = new PrinterService({
    config: loadConfig({
      PRINTER_IP: '127.0.0.1',
      DISCOVERY_ENABLED: 'false',
      DATABASE_PATH: join(dir, 'test.sqlite'),
    }),
    store: new PrinterStore(),
    history,
    socketFactory: (url) =>
      new WebSocket(url.replace(/:\d+\//, `:${printer.wsPort}/`)) as unknown as SocketLike,
    discoverImpl: async () => [],
  });
  services.push(service);
  await service.start();
  return service;
}

function stopServer(service: PrinterService): void {
  service.stop();
  services.splice(services.indexOf(service), 1);
}

const settle = () => new Promise((r) => setTimeout(r, 150));

/** Runs a whole print on the fake printer, with nobody connected. */
function printToCompletion(taskId: string): void {
  printer.state.startPrint({ filename: 'idol.goo', totalLayer: 30, msPerLayer: 20, taskId });
  printer.tick(30 * 20);
}

describe('a finished print first seen while the printer is idle (CTHU-20)', () => {
  it('records it when the server starts after the print has completed', async () => {
    printToCompletion('finished-before-we-looked');

    await startServer();
    await settle();

    const prints = await history.list();
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({
      taskId: 'finished-before-we-looked',
      filename: 'idol.goo',
      totalLayer: 30,
      outcome: 'complete',
    });
  });

  it('invents no times the printer did not report', async () => {
    // The status frame says how long the print ran, not when it ran, so a
    // print we never saw has neither a start nor a finish we can stand behind.
    printToCompletion('no-times');

    await startServer();
    await settle();

    const [row] = await history.list();
    expect(row?.startedAt).toBeNull();
    expect(row?.finishedAt).toBeNull();
  });

  it('records a stopped print as stopped', async () => {
    printer.state.startPrint({
      filename: 'idol.goo',
      totalLayer: 30,
      msPerLayer: 20,
      taskId: 'abandoned',
    });
    printer.tick(5 * 20);
    printer.state.stop();

    await startServer();
    await settle();

    const prints = await history.list();
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ taskId: 'abandoned', outcome: 'stopped' });
  });

  it('does not duplicate the row on the next restart', async () => {
    printToCompletion('seen-twice');

    stopServer(await startServer());
    await settle();
    await startServer();
    await settle();

    expect(await history.list()).toHaveLength(1);
  });

  it('does not duplicate a print it watched finish', async () => {
    const service = await startServer();
    await settle();
    printer.state.startPrint({
      filename: 'watched.goo',
      totalLayer: 3,
      msPerLayer: 20,
      taskId: 'watched',
    });
    printer.pushStatus();
    await settle();
    printer.tick(3 * 20);
    printer.pushStatus();
    await settle();

    stopServer(service);
    await settle();
    await startServer();
    await settle();

    const prints = await history.list();
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ taskId: 'watched', outcome: 'complete' });
    expect(prints[0]?.startedAt).not.toBeNull();
  });

  it('closes the row of a print it saw start but not finish', async () => {
    // The server goes down mid-print and comes back once it is over: the row
    // it opened is closed, not joined by a second one.
    const service = await startServer();
    await settle();
    printer.state.startPrint({
      filename: 'idol.goo',
      totalLayer: 30,
      msPerLayer: 20,
      taskId: 'gap',
    });
    printer.pushStatus();
    await settle();
    stopServer(service);
    await settle();

    printer.tick(30 * 20);
    await startServer();
    await settle();

    const prints = await history.list();
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ taskId: 'gap', outcome: 'complete' });
    expect(prints[0]?.startedAt).not.toBeNull();
    // When it finished is anybody's guess: some time while we were away.
    expect(prints[0]?.finishedAt).toBeNull();
  });

  it('records nothing for a printer that has never printed', async () => {
    await startServer();
    await settle();

    expect(await history.list()).toHaveLength(0);
  });
});
