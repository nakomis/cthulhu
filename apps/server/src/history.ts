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
 * Print history.
 *
 * Uses node:sqlite, which ships with Node, rather than better-sqlite3. That is
 * a deliberate change from the plan: better-sqlite3 is a native module and
 * Luke is an old N40L with NO AVX, so a prebuilt binary is a real risk and a
 * source build is a slow, fragile step in the image. node:sqlite avoids the
 * question entirely. See CTHU-9.
 */
export class History {
  private readonly db: DatabaseSync;

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

  startPrint(taskId: string | undefined, filename: string | undefined, totalLayer?: number): void {
    // A restart mid-print would otherwise create a duplicate row for the same
    // task, so an existing open row for this task wins.
    if (taskId && this.openRowFor(taskId)) return;
    this.db
      .prepare(
        'INSERT INTO prints (task_id, filename, started_at, outcome, total_layer) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        taskId ?? null,
        filename ?? null,
        new Date().toISOString(),
        'printing',
        totalLayer ?? null,
      );
  }

  finishPrint(taskId: string | undefined, outcome: 'complete' | 'stopped' | 'error'): void {
    const now = new Date().toISOString();
    if (taskId) {
      this.db
        .prepare(
          'UPDATE prints SET finished_at = ?, outcome = ? WHERE task_id = ? AND finished_at IS NULL',
        )
        .run(now, outcome, taskId);
      return;
    }
    this.db
      .prepare(
        'UPDATE prints SET finished_at = ?, outcome = ? WHERE id = (SELECT id FROM prints WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1)',
      )
      .run(now, outcome);
  }

  private openRowFor(taskId: string): boolean {
    const row = this.db
      .prepare('SELECT id FROM prints WHERE task_id = ? AND finished_at IS NULL')
      .get(taskId);
    return row !== undefined;
  }

  list(limit = 50): PrintRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, task_id, filename, started_at, finished_at, outcome, total_layer FROM prints ORDER BY id DESC LIMIT ?',
      )
      .all(limit) as Record<string, unknown>[];

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

  close(): void {
    this.db.close();
  }
}
