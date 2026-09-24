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
