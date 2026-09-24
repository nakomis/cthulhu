import { describe, expect, it } from 'vitest';
import { migrateRows, parseArgs, type SqliteRow } from './migrate-history.js';
import type { PgLike } from './postgres-history.js';

async function pglite(): Promise<{ db: PgLike; close: () => Promise<void> }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const instance = new PGlite();
  return {
    db: {
      query: (text, params) =>
        instance.query(text, params) as unknown as ReturnType<PgLike['query']>,
    },
    close: () => instance.close(),
  };
}

const row = (overrides: Partial<SqliteRow> = {}): SqliteRow => ({
  task_id: null,
  filename: null,
  started_at: null,
  finished_at: null,
  outcome: 'complete',
  total_layer: null,
  ...overrides,
});

describe('parseArgs', () => {
  it('reads --sqlite and --database-url', () => {
    expect(
      parseArgs(['--sqlite', '/data/cthulhu.sqlite', '--database-url', 'postgres://x']),
    ).toEqual({ sqlitePath: '/data/cthulhu.sqlite', databaseUrl: 'postgres://x' });
  });

  it('leaves both undefined when neither flag is given', () => {
    expect(parseArgs([])).toEqual({ sqlitePath: undefined, databaseUrl: undefined });
  });
});

describe('migrateRows', () => {
  it('copies every row into an empty database', async () => {
    const { db, close } = await pglite();
    try {
      const rows = [
        row({ task_id: 't1', filename: 'a.goo', started_at: '2026-01-01T00:00:00Z' }),
        row({ task_id: 't2', filename: 'b.goo', started_at: '2026-01-02T00:00:00Z' }),
      ];
      const result = await migrateRows(rows, db);
      expect(result).toEqual({ copied: 2, skipped: 0 });

      const { rows: stored } = await db.query<{ task_id: string }>('SELECT task_id FROM prints');
      expect(stored.map((r) => r.task_id).sort()).toEqual(['t1', 't2']);
    } finally {
      await close();
    }
  });

  it('skips a row whose task_id is already in Postgres', async () => {
    const { db, close } = await pglite();
    try {
      await migrateRows([row({ task_id: 't1', filename: 'a.goo' })], db);
      const result = await migrateRows([row({ task_id: 't1', filename: 'a.goo' })], db);
      expect(result).toEqual({ copied: 0, skipped: 1 });

      const { rows: stored } = await db.query('SELECT * FROM prints');
      expect(stored).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('matches a task_id-less row by started_at, so it is only ever copied once', async () => {
    const { db, close } = await pglite();
    try {
      const startedAt = '2025-06-01T12:00:00.000Z';
      await migrateRows([row({ started_at: startedAt, filename: 'legacy.goo' })], db);
      const result = await migrateRows(
        [row({ started_at: startedAt, filename: 'legacy.goo' })],
        db,
      );
      expect(result).toEqual({ copied: 0, skipped: 1 });
    } finally {
      await close();
    }
  });

  it('copies a mix of new and already-present rows in one pass', async () => {
    const { db, close } = await pglite();
    try {
      await migrateRows([row({ task_id: 't1' })], db);
      const result = await migrateRows(
        [row({ task_id: 't1' }), row({ task_id: 't2' }), row({ task_id: 't3' })],
        db,
      );
      expect(result).toEqual({ copied: 2, skipped: 1 });
    } finally {
      await close();
    }
  });

  it('calls the log callback with a summary', async () => {
    const { db, close } = await pglite();
    try {
      const lines: string[] = [];
      await migrateRows([row({ task_id: 't1' })], db, (line) => lines.push(line));
      expect(lines[0]).toMatch(/Migrated 1 row/);
    } finally {
      await close();
    }
  });
});
