import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// pg.Pool is mocked so this test never dials a real server: it only checks
// that createHistoryStore wires DATABASE_URL through to Postgres rather than
// SQLite. PostgresHistory's own behaviour is covered against PGlite in
// postgres-history.test.ts.
const query = vi.fn(async (text: string) => {
  if (text.includes('SELECT')) return { rows: [] };
  return { rows: [] };
});
vi.mock('pg', () => ({
  Pool: class {
    query = query;
  },
}));

const { createHistoryStore, SqliteHistory } = await import('./history.js');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'history-'));
  query.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('createHistoryStore', () => {
  it('uses SQLite when no DATABASE_URL is given', async () => {
    const store = await createHistoryStore({ databasePath: join(dir, 'test.sqlite') });
    expect(store).toBeInstanceOf(SqliteHistory);
    await store.close();
  });

  it('uses Postgres when DATABASE_URL is set, creating the table on the way in', async () => {
    const store = await createHistoryStore({
      databasePath: join(dir, 'unused.sqlite'),
      databaseUrl: 'postgres://user:pass@luke:5432/cthulhu',
    });
    expect(store).not.toBeInstanceOf(SqliteHistory);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS prints'),
    );
  });
});

describe('SqliteHistory.recordFinished (CTHU-20)', () => {
  it('adds a row for an unrecorded task once, with no times', async () => {
    const history = new SqliteHistory(join(dir, 'test.sqlite'));
    await history.recordFinished('t1', 'idol.goo', 30, 'complete');
    await history.recordFinished('t1', 'idol.goo', 30, 'complete');
    expect(await history.list()).toMatchObject([
      { taskId: 't1', filename: 'idol.goo', totalLayer: 30, outcome: 'complete', startedAt: null },
    ]);
    await history.close();
  });

  it('closes the open row of a task it saw start, keeping its start', async () => {
    const history = new SqliteHistory(join(dir, 'test.sqlite'));
    await history.startPrint('t1', 'idol.goo', 30, '2026-09-24T10:00:00.000Z');
    await history.recordFinished('t1', 'idol.goo', 30, 'stopped');
    expect(await history.list()).toMatchObject([
      { outcome: 'stopped', startedAt: '2026-09-24T10:00:00.000Z', finishedAt: null },
    ]);
    await history.close();
  });

  it('is not mistaken for an open row by a later finishPrint', async () => {
    const history = new SqliteHistory(join(dir, 'test.sqlite'));
    await history.recordFinished('t1', 'idol.goo', 30, 'complete');
    await history.finishPrint(undefined, 'stopped');
    expect(await history.list()).toMatchObject([{ outcome: 'complete', finishedAt: null }]);
    await history.close();
  });

  it('is a no-op once closed', async () => {
    const history = new SqliteHistory(join(dir, 'test.sqlite'));
    await history.close();
    await expect(history.recordFinished('t1', 'idol.goo', 30, 'complete')).resolves.toBeUndefined();
  });
});
