import type { HistoryState, HistoryStore, PrintRecord } from './history.js';
import { SqliteHistory } from './history.js';
import type { PostgresHistory } from './postgres-history.js';

export interface FailoverHistoryOptions {
  /** Creates the Postgres store (table included). Called again on each probe while it fails. */
  connect: () => Promise<PostgresHistory>;
  /** The SQLite file used as the journal while Postgres is unreachable. */
  sqlitePath: string;
  /** How often to retry Postgres while it is unreachable; 0 disables the timer (tests call recover()). */
  probeIntervalMs?: number;
  log?: (msg: string) => void;
}

/**
 * Print history in Postgres that survives Postgres going away (CTHU-41).
 *
 * When Luke died in November 2026, cthulhu's DATABASE_URL pointed at a server
 * that no longer existed: Postgres down at startup meant no history at all,
 * and Postgres failing mid-run left history's floating promises to reject,
 * unhandled, which Node exits on.
 *
 * So every write goes to Postgres, and on any failure this switches to a
 * SQLite journal at DATABASE_PATH, says so once, and retries Postgres on a
 * timer. When Postgres answers, the journal is replayed into it row by row
 * (PostgresHistory.absorb, which leaves each print exactly once however often
 * it runs), each row deleted only once it is safely in, and only then do
 * writes go back to Postgres. Nothing here ever rejects.
 */
export class FailoverHistory implements HistoryStore {
  private readonly connect: () => Promise<PostgresHistory>;
  private readonly journal: SqliteHistory;
  private readonly probeIntervalMs: number;
  private readonly log: (msg: string) => void;
  private primary: PostgresHistory | undefined;
  /** Set while Postgres is unreachable (or a replay has not finished). */
  private failedSince: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The recovery in progress, so a probe and a write never replay at once. */
  private recovering: Promise<void> | undefined;
  /** An outage has been logged, so its end gets logged too. */
  private announced = false;
  /** The last probe failure, logged once and shown in state() until it changes. */
  private lastError: string | undefined;
  private closed = false;

  private constructor(options: FailoverHistoryOptions) {
    this.connect = options.connect;
    this.journal = new SqliteHistory(options.sqlitePath);
    this.probeIntervalMs = options.probeIntervalMs ?? 30_000;
    this.log = options.log ?? (() => {});
  }

  /**
   * Connects if it can and replays anything an earlier run left in the
   * journal. Never rejects: with Postgres down it starts in fallback.
   */
  static async create(options: FailoverHistoryOptions): Promise<FailoverHistory> {
    const store = new FailoverHistory(options);
    // Start as if failed, so the first recover() both connects and replays
    // rows an earlier run may have left in the journal.
    store.failedSince = new Date().toISOString();
    await store.recover();
    if (store.failedSince) {
      store.log('history: Postgres unreachable at startup; recording to SQLite until it is back');
      store.announced = true;
      store.startProbe();
    }
    return store;
  }

  async startPrint(
    taskId: string | undefined,
    filename: string | undefined,
    totalLayer?: number,
    startedAt: string = new Date().toISOString(),
  ): Promise<void> {
    if (await this.tryPrimary((p) => p.startPrint(taskId, filename, totalLayer, startedAt))) return;
    await this.journal.startPrint(taskId, filename, totalLayer, startedAt);
  }

  async finishPrint(
    taskId: string | undefined,
    outcome: 'complete' | 'stopped' | 'error',
  ): Promise<void> {
    if (await this.tryPrimary((p) => p.finishPrint(taskId, outcome))) return;
    // A print that started in Postgres has no open row in the journal; its end
    // must still be kept, or the replay would leave it open for ever.
    // (Without a task id there is nothing to tie an end to a Postgres row by,
    // so it closes the journal's newest open row, as SqliteHistory always has.
    // The Mars 5 Ultra sends a task id with every print, so this is a corner.)
    if (taskId && !this.journal.hasOpenRow(taskId)) {
      await this.journal.recordClosed(taskId, outcome);
      return;
    }
    await this.journal.finishPrint(taskId, outcome);
  }

  async recordFinished(
    taskId: string,
    filename: string | undefined,
    totalLayer: number | undefined,
    outcome: 'complete' | 'stopped',
  ): Promise<void> {
    if (await this.tryPrimary((p) => p.recordFinished(taskId, filename, totalLayer, outcome))) {
      return;
    }
    await this.journal.recordFinished(taskId, filename, totalLayer, outcome);
  }

  /**
   * In fallback: the journal's rows (the newest), then whatever Postgres will
   * give, de-duplicated by task (the journal's copy wins, being later). The
   * journal's ids are negated so they never collide with Postgres's, which
   * the UI uses as list keys.
   */
  async list(limit = 50): Promise<PrintRecord[]> {
    if (!this.failedSince && this.primary) {
      try {
        return await this.primary.list(limit);
      } catch (err) {
        this.fail(err);
      }
    }
    const journal = this.journal
      .allRows()
      .reverse()
      .map((r) => ({ ...r, id: -r.id }));
    let fromPostgres: PrintRecord[] = [];
    if (this.primary) {
      try {
        fromPostgres = await this.primary.list(limit);
      } catch {
        // Still down: the journal is all there is.
      }
    }
    // The journal's copy is the later one, but may hold only the end of a
    // print that started in Postgres (recordClosed has no filename or start),
    // so it is merged over the Postgres row rather than replacing it.
    const fromPg = new Map(fromPostgres.filter((r) => r.taskId).map((r) => [r.taskId, r]));
    const merged = journal.map((j) => {
      const pg = j.taskId ? fromPg.get(j.taskId) : undefined;
      if (!pg) return j;
      fromPg.delete(j.taskId);
      return {
        ...j,
        filename: j.filename ?? pg.filename,
        startedAt: j.startedAt ?? pg.startedAt,
        totalLayer: j.totalLayer ?? pg.totalLayer,
        finishedAt: j.finishedAt ?? pg.finishedAt,
      };
    });
    const rest = fromPostgres.filter((r) => !r.taskId || fromPg.has(r.taskId));
    return [...merged, ...rest].slice(0, limit);
  }

  state(): HistoryState {
    if (this.failedSince) {
      return {
        store: 'fallback',
        pending: this.journal.allRows().length,
        since: this.failedSince,
        ...(this.lastError ? { lastError: this.lastError } : {}),
      };
    }
    return { store: 'postgres', pending: 0 };
  }

  /**
   * Connects (or pings) and replays the journal. Public so tests can drive it;
   * the probe timer calls it too. Concurrent calls share one attempt.
   */
  recover(): Promise<void> {
    if (!this.failedSince || this.closed) return Promise.resolve();
    this.recovering ??= this.attemptRecovery().finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.recovering;
    await this.primary?.close();
    await this.journal.close();
  }

  private async attemptRecovery(): Promise<void> {
    try {
      if (this.primary) await this.primary.ping();
      else this.primary = await this.connect();
      // Drain, rather than walk a snapshot: re-read the oldest row each time,
      // so nothing written to the journal mid-replay is skipped. (Writes wait
      // for a replay in progress anyway - see tryPrimary - so this is the
      // second line, not the first.)
      let replayed = 0;
      for (let row = this.journal.allRows()[0]; row; row = this.journal.allRows()[0]) {
        const { id, ...record } = row;
        await this.primary.absorb(record);
        this.journal.deleteRow(id);
        replayed += 1;
      }
      // Nothing awaits between the journal's last empty check and this, so no
      // write can slip into the journal after it was found empty.
      this.failedSince = undefined;
      this.lastError = undefined;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      if (replayed > 0 || this.announced) {
        this.log(`history: Postgres is back; replayed ${replayed} row(s) from SQLite`);
      }
      this.announced = false;
    } catch (err) {
      // Still unreachable, or dropped again mid-replay: rows replayed so far
      // are already deleted from the journal, the rest wait for the next probe.
      // A failure that is not the outage (a bad query, say) would otherwise
      // retry silently for ever, so each new error is logged once and shown in
      // state() for /api/status.
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.lastError) {
        this.lastError = message;
        this.log(`history: Postgres still unavailable (${message})`);
      }
    }
  }

  /** Runs `write` against Postgres unless it is down; false means "use the journal". */
  private async tryPrimary(write: (p: PostgresHistory) => Promise<void>): Promise<boolean> {
    // A write must not go to the journal while a replay is reading it, nor to
    // Postgres before the replay has finished, or it could be stranded behind
    // or overtake rows still being copied. So it waits, then picks a store.
    if (this.recovering) await this.recovering;
    if (this.closed) return true;
    if (this.failedSince || !this.primary) return false;
    try {
      await write(this.primary);
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  private fail(err: unknown): void {
    if (this.failedSince) return;
    this.failedSince = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    this.log(`history: Postgres write failed (${message}); recording to SQLite until it is back`);
    this.announced = true;
    this.startProbe();
  }

  private startProbe(): void {
    if (this.probeIntervalMs <= 0 || this.timer || this.closed) return;
    this.timer = setInterval(() => void this.recover(), this.probeIntervalMs);
    // A history probe must never keep the process alive on its own.
    this.timer.unref?.();
  }
}
