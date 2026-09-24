import { DatabaseSync } from 'node:sqlite';

export interface PrintRecord {
  id: number;
  taskId: string | null;
  filename: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: string;
  totalLayer: number | null;
}

/**
 * Print history, kept somewhere that survives a restart.
 *
 * Two implementations: SqliteHistory (below), the default and the only one
 * that needs no server of its own, and PostgresHistory (postgres-history.ts),
 * used once cthulhu's storage moves onto Luke's Postgres server and its
 * database file can no longer sit on the same box as the process. Both keep
 * the same semantics - see SqliteHistory's own comment for why they matter.
 */
export interface HistoryStore {
  startPrint(
    taskId: string | undefined,
    filename: string | undefined,
    totalLayer?: number,
    startedAt?: string,
  ): Promise<void>;
  finishPrint(taskId: string | undefined, outcome: 'complete' | 'stopped' | 'error'): Promise<void>;
  list(limit?: number): Promise<PrintRecord[]>;
  close(): Promise<void>;
}

/**
 * Print history, using node:sqlite, which ships with Node, rather than
 * better-sqlite3. That is a deliberate change from the plan: better-sqlite3
 * is a native module and Luke is an old N40L with NO AVX, so a prebuilt
 * binary is a real risk and a source build is a slow, fragile step in the
 * image. node:sqlite avoids the question entirely. See CTHU-9.
 *
 * SQLite must never live on a network share (WAL and locking do not work over
 * Samba/NFS), which is exactly why PostgresHistory exists for the deployment
 * where storage moves onto Luke and the server does not: see CTHU-15.
 */
export class SqliteHistory implements HistoryStore {
  private readonly db: DatabaseSync;
  /**
   * node:sqlite throws ERR_INVALID_STATE on a closed handle, and status frames
   * can still be in flight while the server shuts down - a print completing at
   * the moment of a restart would otherwise throw from inside an event handler
   * with nothing to catch it. History is best-effort by design, so a write
   * after close is a no-op, not a crash.
   */
  private closed = false;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prints (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT,
        filename    TEXT,
        started_at  TEXT,
        finished_at TEXT,
        outcome     TEXT NOT NULL DEFAULT 'unknown',
        total_layer INTEGER
      );
      CREATE INDEX IF NOT EXISTS prints_task_id ON prints(task_id);
    `);
  }

  // Synchronous under the hood (node:sqlite has no async API); wrapped in a
  // resolved promise to satisfy HistoryStore, which PostgresHistory cannot
  // implement synchronously.
  startPrint(
    taskId: string | undefined,
    filename: string | undefined,
    totalLayer?: number,
    startedAt: string = new Date().toISOString(),
  ): Promise<void> {
    if (this.closed) return Promise.resolve();
    // A restart mid-print would otherwise create a duplicate row for the same
    // task, so an existing open row for this task wins.
    if (taskId && this.openRowFor(taskId)) return Promise.resolve();
    this.db
      .prepare(
        'INSERT INTO prints (task_id, filename, started_at, outcome, total_layer) VALUES (?, ?, ?, ?, ?)',
      )
      .run(taskId ?? null, filename ?? null, startedAt, 'printing', totalLayer ?? null);
    return Promise.resolve();
  }

  finishPrint(
    taskId: string | undefined,
    outcome: 'complete' | 'stopped' | 'error',
  ): Promise<void> {
    if (this.closed) return Promise.resolve();
    const now = new Date().toISOString();
    if (taskId) {
      this.db
        .prepare(
          'UPDATE prints SET finished_at = ?, outcome = ? WHERE task_id = ? AND finished_at IS NULL',
        )
        .run(now, outcome, taskId);
      return Promise.resolve();
    }
    this.db
      .prepare(
        'UPDATE prints SET finished_at = ?, outcome = ? WHERE id = (SELECT id FROM prints WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1)',
      )
      .run(now, outcome);
    return Promise.resolve();
  }

  private openRowFor(taskId: string): boolean {
    const row = this.db
      .prepare('SELECT id FROM prints WHERE task_id = ? AND finished_at IS NULL')
      .get(taskId);
    return row !== undefined;
  }

  list(limit = 50): Promise<PrintRecord[]> {
    if (this.closed) return Promise.resolve([]);
    const rows = this.db
      .prepare(
        'SELECT id, task_id, filename, started_at, finished_at, outcome, total_layer FROM prints ORDER BY id DESC LIMIT ?',
      )
      .all(limit) as Record<string, unknown>[];

    return Promise.resolve(
      rows.map((r) => ({
        id: Number(r.id),
        taskId: (r.task_id as string | null) ?? null,
        filename: (r.filename as string | null) ?? null,
        startedAt: (r.started_at as string | null) ?? null,
        finishedAt: (r.finished_at as string | null) ?? null,
        outcome: String(r.outcome),
        totalLayer: r.total_layer === null ? null : Number(r.total_layer),
      })),
    );
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
    return Promise.resolve();
  }
}

/**
 * Picks the history store from configuration: Postgres when DATABASE_URL is
 * set, SQLite (the development and small-deployment default) otherwise.
 *
 * `pg` is imported dynamically so a SQLite-only deployment never pays for
 * loading it, and so a test importing this module without `pg` installed (as
 * a peer scenario, not this workspace) still works.
 */
export async function createHistoryStore(config: {
  databasePath: string;
  databaseUrl?: string | undefined;
}): Promise<HistoryStore> {
  if (config.databaseUrl) {
    const { Pool } = await import('pg');
    const { PostgresHistory } = await import('./postgres-history.js');
    return PostgresHistory.create(new Pool({ connectionString: config.databaseUrl }));
  }
  return new SqliteHistory(config.databasePath);
}
