import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PgLike } from './postgres-history.js';
import { PostgresHistory } from './postgres-history.js';

/**
 * PGlite is WASM Postgres: a real Postgres query planner and SQL dialect,
 * with no server process, socket or Docker container required. That is what
 * makes it possible to test PostgresHistory's actual SQL (placeholders,
 * SERIAL, subqueries) rather than a mock of `pg` that could drift from what
 * a real server accepts.
 */
async function pgliteStore(): Promise<{ db: PgLike; close: () => Promise<void> }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite();
  const db: PgLike = {
    query: (text, params) => pglite.query(text, params) as unknown as ReturnType<PgLike['query']>,
  };
  return { db, close: () => pglite.close() };
}

let db: PgLike;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await pgliteStore());
});

afterEach(async () => {
  await close();
});

describe('PostgresHistory', () => {
  it('creates its table if absent, and lists nothing to start', async () => {
    const history = await PostgresHistory.create(db);
    expect(await history.list()).toEqual([]);
  });

  it('records a started print and lists it, newest first', async () => {
    const history = await PostgresHistory.create(db);
    await history.startPrint('t1', 'cthulhu.goo', 120, '2026-09-24T10:00:00.000Z');
    await history.startPrint('t2', 'kraken.goo', 60, '2026-09-24T11:00:00.000Z');

    const prints = await history.list();
    expect(prints).toHaveLength(2);
    expect(prints[0]).toMatchObject({ taskId: 't2', filename: 'kraken.goo', outcome: 'printing' });
    expect(prints[1]).toMatchObject({ taskId: 't1', totalLayer: 120 });
  });

  it('does not create a duplicate open row for a task after a restart', async () => {
    const history = await PostgresHistory.create(db);
    await history.startPrint('t1', 'cthulhu.goo', 120, '2026-09-24T10:00:00.000Z');
    // Simulates the server reconnecting mid-print and seeing the same taskId
    // again before it has finished.
    await history.startPrint('t1', 'cthulhu.goo', 120, '2026-09-24T10:00:01.000Z');

    expect(await history.list()).toHaveLength(1);
  });

  it('finishPrint updates the open row for that task', async () => {
    const history = await PostgresHistory.create(db);
    await history.startPrint('t1', 'cthulhu.goo');
    await history.finishPrint('t1', 'complete');

    const [row] = await history.list();
    expect(row).toMatchObject({ taskId: 't1', outcome: 'complete' });
    expect(row?.finishedAt).not.toBeNull();
  });

  it('finishPrint with no taskId closes the most recently opened row', async () => {
    const history = await PostgresHistory.create(db);
    await history.startPrint('t1', 'first.goo', undefined, '2026-09-24T10:00:00.000Z');
    await history.startPrint(undefined, 'second.goo', undefined, '2026-09-24T10:05:00.000Z');
    await history.finishPrint(undefined, 'stopped');

    const prints = await history.list();
    // The second (undefined-taskId) row is the one still open, so it is the
    // one finishPrint(undefined, ...) closes - not the first.
    expect(prints.find((p) => p.filename === 'second.goo')).toMatchObject({ outcome: 'stopped' });
    expect(prints.find((p) => p.filename === 'first.goo')).toMatchObject({ outcome: 'printing' });
  });

  it('respects the list limit', async () => {
    const history = await PostgresHistory.create(db);
    for (let i = 0; i < 5; i += 1) await history.startPrint(`t${i}`, `f${i}.goo`);
    expect(await history.list(2)).toHaveLength(2);
  });

  it('is a no-op after close, rather than throwing', async () => {
    const history = await PostgresHistory.create(db);
    await history.startPrint('t1', 'cthulhu.goo');
    await history.close();

    await expect(history.startPrint('t2', 'kraken.goo')).resolves.toBeUndefined();
    await expect(history.finishPrint('t1', 'complete')).resolves.toBeUndefined();
    expect(await history.list()).toEqual([]);
  });

  it('creating the store twice against the same database is idempotent', async () => {
    await PostgresHistory.create(db);
    const again = await PostgresHistory.create(db);
    await again.startPrint('t1', 'cthulhu.goo');
    expect(await again.list()).toHaveLength(1);
  });
});
