import type { HistoryStore, PrintRecord } from './history.js';

/**
 * The minimal shape PostgresHistory needs from a Postgres client: exactly
 * what `pg.Pool` and `pg.Client` already provide, and nothing they don't.
 * Kept this narrow so tests can satisfy it with something far lighter than a
 * real server - see postgres-history.test.ts, which uses PGlite (WASM
 * Postgres) rather than mocking SQL calls or standing up a real database.
 */
export interface PgLike {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  /** Optional: pg.Pool has it, PGlite does not. Called once, from close(). */
  end?(): Promise<void>;
}

/**
 * Print history in Postgres, for the deployment where storage lives on
 * Luke's Postgres server rather than beside the process - see CTHU-15.
 * SQLite (history.ts) cannot make that move: WAL and locking do not work over
 * a network share, which is the whole reason this class exists.
 *
 * Same table shape and the same semantics as SqliteHistory - in particular,
 * no duplicate open row for a task after a restart, and finishPrint updates
 * whichever row is still open - so the two are interchangeable from the rest
 * of the server's point of view.
 */
export class PostgresHistory implements HistoryStore {
  private readonly db: PgLike;
  private closed = false;

  private constructor(db: PgLike) {
    this.db = db;
  }

  /** Creates the table if it is not already there, then returns the store. */
  static async create(db: PgLike): Promise<PostgresHistory> {
    await db.query(`
      CREATE TABLE IF NOT EXISTS prints (
        id          SERIAL PRIMARY KEY,
        task_id     TEXT,
        filename    TEXT,
        started_at  TEXT,
        finished_at TEXT,
        outcome     TEXT NOT NULL DEFAULT 'unknown',
        total_layer INTEGER
      )
    `);
    await db.query('CREATE INDEX IF NOT EXISTS prints_task_id ON prints(task_id)');
    return new PostgresHistory(db);
  }

  async startPrint(
    taskId: string | undefined,
    filename: string | undefined,
    totalLayer?: number,
    startedAt: string = new Date().toISOString(),
  ): Promise<void> {
    if (this.closed) return;
    // A restart mid-print would otherwise create a duplicate row for the same
    // task, so an existing open row for this task wins.
    if (taskId && (await this.openRowFor(taskId))) return;
    await this.db.query(
      'INSERT INTO prints (task_id, filename, started_at, outcome, total_layer) VALUES ($1, $2, $3, $4, $5)',
      [taskId ?? null, filename ?? null, startedAt, 'printing', totalLayer ?? null],
    );
  }

  async finishPrint(
    taskId: string | undefined,
    outcome: 'complete' | 'stopped' | 'error',
  ): Promise<void> {
    if (this.closed) return;
    const now = new Date().toISOString();
    if (taskId) {
      await this.db.query(
        'UPDATE prints SET finished_at = $1, outcome = $2 WHERE task_id = $3 AND finished_at IS NULL',
        [now, outcome, taskId],
      );
      return;
    }
    await this.db.query(
      `UPDATE prints SET finished_at = $1, outcome = $2
       WHERE id = (SELECT id FROM prints WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1)`,
      [now, outcome],
    );
  }

  private async openRowFor(taskId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT id FROM prints WHERE task_id = $1 AND finished_at IS NULL',
      [taskId],
    );
    return rows.length > 0;
  }

  async list(limit = 50): Promise<PrintRecord[]> {
    if (this.closed) return [];
    const { rows } = await this.db.query(
      'SELECT id, task_id, filename, started_at, finished_at, outcome, total_layer FROM prints ORDER BY id DESC LIMIT $1',
      [limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: (r.task_id as string | null) ?? null,
      filename: (r.filename as string | null) ?? null,
      startedAt: (r.started_at as string | null) ?? null,
      finishedAt: (r.finished_at as string | null) ?? null,
      outcome: String(r.outcome),
      totalLayer: r.total_layer === null ? null : Number(r.total_layer),
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.db.end?.();
  }
}
