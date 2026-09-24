#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import type { PgLike } from './postgres-history.js';
import { PostgresHistory } from './postgres-history.js';

/**
 * `cthulhu-migrate-history` - copy print history from a SQLite file into
 * Postgres, once. Run against Luke's /mnt/data/cthulhu/cthulhu.sqlite when
 * moving the server off Luke onto Postgres storage - see CTHU-15.
 *
 *   node dist/migrate-history.js --sqlite /mnt/data/cthulhu/cthulhu.sqlite --database-url postgres://user:pass@luke:5432/cthulhu
 *
 * or via env: SQLITE_PATH and DATABASE_URL.
 *
 * Idempotent, so it is safe to run more than once (a second pass while the
 * old and new servers overlap, say): a row with a task_id already present in
 * Postgres is skipped, and a row with no task_id (older rows, from before
 * every print reliably got one) is matched and skipped by its started_at
 * timestamp instead, since that is all such a row has to identify it by.
 */

export interface Args {
  sqlitePath: string | undefined;
  databaseUrl: string | undefined;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { sqlitePath: undefined, databaseUrl: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--sqlite':
        args.sqlitePath = argv[i + 1];
        i += 1;
        break;
      case '--database-url':
        args.databaseUrl = argv[i + 1];
        i += 1;
        break;
      default:
        break;
    }
  }
  return args;
}

export interface SqliteRow {
  task_id: string | null;
  filename: string | null;
  started_at: string | null;
  finished_at: string | null;
  outcome: string;
  total_layer: number | null;
}

/**
 * The migration itself, kept apart from CLI plumbing (argv, opening the
 * SQLite file, ending the pool) so it can be tested against PGlite without a
 * real SQLite file or Postgres server - see migrate-history.test.ts.
 */
export async function migrateRows(
  rows: SqliteRow[],
  db: PgLike,
  log: (line: string) => void = () => {},
): Promise<{ copied: number; skipped: number }> {
  // Ensures the table exists, same as the server does on startup.
  await PostgresHistory.create(db);

  const seenTaskIds = new Set(
    (
      await db.query<{ task_id: string }>(
        'SELECT DISTINCT task_id FROM prints WHERE task_id IS NOT NULL',
      )
    ).rows.map((r) => r.task_id),
  );
  const seenStartedAts = new Set(
    (
      await db.query<{ started_at: string }>(
        'SELECT started_at FROM prints WHERE task_id IS NULL AND started_at IS NOT NULL',
      )
    ).rows.map((r) => r.started_at),
  );

  let copied = 0;
  let skipped = 0;
  for (const row of rows) {
    const alreadyThere = row.task_id
      ? seenTaskIds.has(row.task_id)
      : row.started_at !== null && seenStartedAts.has(row.started_at);
    if (alreadyThere) {
      skipped += 1;
      continue;
    }

    await db.query(
      'INSERT INTO prints (task_id, filename, started_at, finished_at, outcome, total_layer) VALUES ($1, $2, $3, $4, $5, $6)',
      [row.task_id, row.filename, row.started_at, row.finished_at, row.outcome, row.total_layer],
    );
    if (row.task_id) seenTaskIds.add(row.task_id);
    else if (row.started_at) seenStartedAts.add(row.started_at);
    copied += 1;
  }

  log(`Migrated ${copied} row(s); ${skipped} already present, skipped.`);
  return { copied, skipped };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sqlitePath = args.sqlitePath ?? process.env.SQLITE_PATH;
  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL;
  if (!sqlitePath || !databaseUrl) {
    process.stderr.write(
      'Usage: migrate-history --sqlite <path> --database-url <postgres-url>\n' +
        '(or SQLITE_PATH / DATABASE_URL in the environment)\n',
    );
    process.exitCode = 2;
    return;
  }

  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const rows = sqlite
    .prepare(
      'SELECT task_id, filename, started_at, finished_at, outcome, total_layer FROM prints ORDER BY id',
    )
    .all() as unknown as SqliteRow[];
  sqlite.close();

  const pool = new Pool({ connectionString: databaseUrl });
  await migrateRows(rows, pool, (line) => process.stdout.write(`${line}\n`));
  await pool.end();
}

// Only run as a CLI, not when migrateRows/parseArgs are imported for tests -
// there is no `require.main === module` in ESM, so this is the equivalent.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`Migration failed: ${String(err)}\n`);
    process.exitCode = 1;
  });
}
