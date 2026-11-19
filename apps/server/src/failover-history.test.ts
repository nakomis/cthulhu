import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePrinter, type FakePrinter } from '@cthulhu/fake-printer';
import type { SocketLike } from '@cthulhu/sdcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadConfig } from './config.js';
import { FailoverHistory } from './failover-history.js';
import type { HistoryStore } from './history.js';
import { SqliteHistory } from './history.js';
import type { PgLike } from './postgres-history.js';
import { PostgresHistory } from './postgres-history.js';
import { PrinterService } from './printer.js';
import { PrinterStore } from './store.js';

// CTHU-41: when Luke died, cthulhu's Postgres went with it. Print history must
// survive an outage like that: written to SQLite meanwhile, replayed into
// Postgres exactly once when it is back.

/**
 * Real Postgres SQL (PGlite) behind a switch. With `down` set, every query
 * fails the way pg fails when the server's host has gone.
 */
interface SwitchablePg {
  db: PgLike;
  down: boolean;
  close: () => Promise<void>;
}

async function switchablePg(): Promise<SwitchablePg> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite();
  const sw: SwitchablePg = {
    down: false,
    db: {
      query: (text, params) => {
        if (sw.down) {
          return Promise.reject(
            Object.assign(new Error('connect EHOSTUNREACH 172.29.0.30:5435'), {
              code: 'EHOSTUNREACH',
            }),
          );
        }
        return pglite.query(text, params) as unknown as ReturnType<PgLike['query']>;
      },
    },
    close: () => pglite.close(),
  };
  return sw;
}

let pg: SwitchablePg;
let dir: string;
let sqlitePath: string;
const stores: HistoryStore[] = [];

beforeEach(async () => {
  pg = await switchablePg();
  dir = mkdtempSync(join(tmpdir(), 'cthulhu-failover-'));
  sqlitePath = join(dir, 'fallback.sqlite');
});

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  await pg.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A FailoverHistory whose probe never fires on its own: tests call recover(). */
async function failover(): Promise<FailoverHistory> {
  const store = await FailoverHistory.create({
    connect: () => PostgresHistory.create(pg.db),
    sqlitePath,
    probeIntervalMs: 0,
  });
  stores.push(store);
  return store;
}

/** Every row Postgres holds, oldest first, read directly. */
async function postgresRows(): Promise<Record<string, unknown>[]> {
  const was = pg.down;
  pg.down = false;
  const { rows } = await pg.db.query('SELECT * FROM prints ORDER BY id');
  pg.down = was;
  return rows;
}

function sqliteRowCount(): number {
  const sqlite = new SqliteHistory(sqlitePath);
  const n = sqlite.allRows().length;
  void sqlite.close();
  return n;
}

describe('FailoverHistory (CTHU-41)', () => {
  it('writes only to Postgres while Postgres is up', async () => {
    const history = await failover();
    await history.startPrint('t1', 'idol.goo', 30, '2026-11-19T10:00:00.000Z');
    await history.finishPrint('t1', 'complete');

    expect(await postgresRows()).toHaveLength(1);
    expect(sqliteRowCount()).toBe(0);
    expect(history.state()).toEqual({ store: 'postgres', pending: 0 });
  });

  it('records a print that started in Postgres and finished during an outage, once', async () => {
    const history = await failover();
    await history.startPrint('t1', 'idol.goo', 30, '2026-11-19T10:00:00.000Z');

    pg.down = true;
    await history.finishPrint('t1', 'complete');
    expect(history.state()).toMatchObject({ store: 'fallback', pending: 1 });

    pg.down = false;
    await history.recover();

    const rows = await postgresRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: 't1', outcome: 'complete' });
    expect(rows[0]?.finished_at).not.toBeNull();
    expect(sqliteRowCount()).toBe(0);
    expect(history.state()).toEqual({ store: 'postgres', pending: 0 });
  });

  it('replays a whole print that happened during an outage, exactly once', async () => {
    const history = await failover();
    pg.down = true;
    await history.startPrint('t2', 'rook.goo', 40, '2026-11-19T11:00:00.000Z');
    await history.finishPrint('t2', 'stopped');

    pg.down = false;
    await history.recover();
    await history.recover();

    const rows = await postgresRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task_id: 't2',
      filename: 'rook.goo',
      started_at: '2026-11-19T11:00:00.000Z',
      outcome: 'stopped',
    });
  });

  it('starts in fallback when Postgres is down at startup, and catches up when it returns', async () => {
    pg.down = true;
    const history = await failover();
    expect(history.state()).toMatchObject({ store: 'fallback' });

    await history.startPrint('t3', 'spatula.goo', 20, '2026-11-19T12:00:00.000Z');
    await history.finishPrint('t3', 'complete');

    pg.down = false;
    await history.recover();

    expect(await postgresRows()).toHaveLength(1);
    expect(history.state()).toEqual({ store: 'postgres', pending: 0 });
  });

  it('replays rows left in SQLite by an earlier run, skipping ones Postgres already has', async () => {
    const pgHistory = await PostgresHistory.create(pg.db);
    await pgHistory.startPrint('kept', 'spatula.goo', 320, '2026-11-10T13:03:16.306Z');
    await pgHistory.finishPrint('kept', 'complete');
    const leftover = new SqliteHistory(sqlitePath);
    await leftover.recordFinished('kept', 'spatula.goo', 320, 'complete');
    await leftover.startPrint('new', 'idol.goo', 30, '2026-11-19T13:00:00.000Z');
    await leftover.close();

    await failover();

    const rows = await postgresRows();
    expect(rows.map((r) => r.task_id)).toEqual(['kept', 'new']);
    expect(sqliteRowCount()).toBe(0);
  });

  it('loses and duplicates nothing when Postgres drops again mid-replay', async () => {
    const history = await failover();
    pg.down = true;
    for (const t of ['a', 'b', 'c']) {
      await history.startPrint(t, `${t}.goo`, 10, `2026-11-19T14:0${t.charCodeAt(0) - 97}:00.000Z`);
      await history.finishPrint(t, 'complete');
    }

    // Up for exactly two absorbs' worth of queries, then down again.
    pg.down = false;
    let budget = 0;
    const realQuery = pg.db.query;
    pg.db.query = ((text: string, params?: unknown[]) => {
      if (text.startsWith('INSERT')) budget += 1;
      if (budget > 1) pg.down = true;
      return realQuery(text, params);
    }) as PgLike['query'];
    await history.recover();
    pg.db.query = realQuery;
    expect(history.state()).toMatchObject({ store: 'fallback' });

    pg.down = false;
    await history.recover();

    expect((await postgresRows()).map((r) => r.task_id)).toEqual(['a', 'b', 'c']);
    expect(sqliteRowCount()).toBe(0);
  });

  it('lists SQLite and Postgres rows together during an outage, without duplicates or id clashes', async () => {
    const history = await failover();
    await history.startPrint('before', 'one.goo', 10, '2026-11-19T15:00:00.000Z');
    await history.finishPrint('before', 'complete');

    pg.down = true;
    await history.startPrint('during', 'two.goo', 10, '2026-11-19T16:00:00.000Z');

    const listed = await history.list();
    expect(listed.map((p) => p.taskId)).toEqual(['during']);
    expect(new Set(listed.map((p) => p.id)).size).toBe(listed.length);

    // Postgres reachable for reads again, but not yet recovered: both appear.
    pg.down = false;
    const both = await history.list();
    expect(both.map((p) => p.taskId)).toEqual(['during', 'before']);
    expect(new Set(both.map((p) => p.id)).size).toBe(2);
  });

  it('never rejects, whatever Postgres does', async () => {
    const history = await failover();
    pg.down = true;
    await expect(history.startPrint('x', 'x.goo', 1)).resolves.toBeUndefined();
    await expect(history.finishPrint('x', 'error')).resolves.toBeUndefined();
    await expect(history.recordFinished('y', 'y.goo', 1, 'complete')).resolves.toBeUndefined();
    await expect(history.list()).resolves.toHaveLength(2);
  });
});

describe('PrinterService with a history store that fails (CTHU-41)', () => {
  let printer: FakePrinter;
  let service: PrinterService | undefined;

  beforeEach(async () => {
    printer = await createFakePrinter({ discovery: false, statusIntervalMs: 40, msPerLayer: 20 });
  });

  afterEach(async () => {
    service?.stop();
    await printer.close();
  });

  it('survives a store whose writes reject, rather than leaving an unhandled rejection', async () => {
    const rejected: unknown[] = [];
    const onRejection = (reason: unknown) => rejected.push(reason);
    process.on('unhandledRejection', onRejection);
    const failing = new Error('connect EHOSTUNREACH 172.29.0.30:5435');
    const rejecting: HistoryStore = {
      startPrint: () => Promise.reject(failing),
      finishPrint: () => Promise.reject(failing),
      recordFinished: () => Promise.reject(failing),
      list: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    };
    const logs: string[] = [];
    try {
      service = new PrinterService({
        config: loadConfig({ PRINTER_IP: '127.0.0.1', DISCOVERY_ENABLED: 'false' }),
        store: new PrinterStore(),
        history: rejecting,
        log: (msg) => logs.push(msg),
        socketFactory: (url) =>
          new WebSocket(url.replace(/:\d+\//, `:${printer.wsPort}/`)) as unknown as SocketLike,
        discoverImpl: async () => [],
      });
      await service.start();
      await new Promise((r) => setTimeout(r, 150));
      printer.state.startPrint({
        filename: 'idol.goo',
        totalLayer: 5,
        msPerLayer: 20,
        taskId: 'r1',
      });
      await new Promise((r) => setTimeout(r, 150));
      printer.tick(5 * 20);
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejected).toEqual([]);
    expect(logs.some((l) => l.includes('history'))).toBe(true);
  });
});
