import { useState } from 'react';
import { api, type PrinterView } from './api.js';
import { Camera } from './Camera.js';
import { Files } from './Files.js';
import { Layer } from './Layer.js';
import {
  canPause,
  canResume,
  canStop,
  formatEta,
  isActive,
  releaseFilmLabel,
  releaseFilmUsage,
} from './status.js';
import { Timelapses } from './Timelapses.js';
import { useStatus } from './useStatus.js';

export interface AppProps {
  /** Injected in tests; defaults to the real API. */
  fetchStatus?: () => Promise<PrinterView>;
  pollMs?: number;
  socketFactory?: (url: string) => WebSocket;
}

export function App({ fetchStatus = api.status, pollMs = 2000, socketFactory }: AppProps) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const {
    view,
    error: feedError,
    live,
    refresh,
  } = useStatus({
    fetchStatus,
    pollMs,
    ...(socketFactory ? { socketFactory } : {}),
  });
  const error = actionError ?? feedError;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmStop = () => {
    // Stopping abandons a print that may have run for hours.
    if (!globalThis.confirm('Stop the print? This abandons it and cannot be undone.')) return;
    void act(api.stop);
  };

  const print = view?.print;
  const progress = print?.progressPercent ?? 0;
  const active = isActive(print?.status);

  return (
    <main className="min-h-dvh bg-abyss text-slate-100 px-4 py-6">
      <header className="mx-auto flex max-w-2xl items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-tentacle">Cthulhu</h1>
          <p className="mt-1 text-sm text-slate-400">
            {view?.attributes?.machineName ?? 'Elegoo Mars 5 Ultra'}
            {view ? (
              <span className={view.connected ? 'text-tentacle' : 'text-amber-400'}>
                {view.connected ? ' · connected' : ' · disconnected'}
              </span>
            ) : null}
            {view && !live ? (
              <span
                className="text-slate-500"
                title="WebSocket unavailable; falling back to polling"
              >
                {' · polling'}
              </span>
            ) : null}
          </p>
        </div>
        <img src="/icon-192.png" alt="" className="size-14 shrink-0 rounded-xl" />
      </header>

      <div className="mx-auto mt-6 max-w-2xl space-y-4">
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
          >
            {error}
          </p>
        ) : null}

        {/* Wraps on a phone: the pictures drop below the words, not over them. */}
        <section className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-slate-700 p-4">
          <div className="min-w-0">
            <h2 className="text-xs uppercase tracking-wider text-slate-400">Status</h2>
            <p className="mt-1 text-2xl">{print?.statusLabel ?? 'Unknown'}</p>
            {print?.filename ? (
              <p className="mt-1 truncate text-sm text-slate-400">{print.filename}</p>
            ) : null}
          </div>
          {print?.taskId ? (
            <div className="flex items-start gap-2">
              {active ? (
                <Layer
                  key={print.taskId}
                  layer={print.currentLayer ?? 0}
                  totalLayer={print.totalLayer}
                />
              ) : null}
              <Preview key={print.taskId} taskId={print.taskId} />
            </div>
          ) : null}
        </section>

        {/* Straight after Status, so it is above the fold on a laptop. */}
        <Camera />

        <section className="rounded-lg border border-slate-700 p-4">
          <h2 className="text-xs uppercase tracking-wider text-slate-400">Progress</h2>
          <div
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-800"
          >
            <div
              className="h-full bg-tentacle transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-slate-400">Layer</dt>
              <dd>
                {print?.currentLayer ?? '—'} / {print?.totalLayer ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Done</dt>
              <dd>{progress}%</dd>
            </div>
            <div>
              <dt className="text-slate-400">Remaining</dt>
              <dd>{formatEta(print?.remainingMs ?? 0)}</dd>
            </div>
          </dl>
        </section>

        <section className="rounded-lg border border-slate-700 p-4">
          <h2 className="text-xs uppercase tracking-wider text-slate-400">FEP Life</h2>
          <p className="mt-1 text-lg">{releaseFilmLabel(view?.releaseFilmState)}</p>
          {view?.releaseFilmUses !== undefined ? (
            <p className="mt-1 text-sm text-slate-400">
              {releaseFilmUsage(view.releaseFilmUses, view.releaseFilmMax)}
            </p>
          ) : null}
        </section>

        <Files busy={active} onChanged={() => void refresh()} />

        <Timelapses />

        <section className="flex gap-2">
          <button
            type="button"
            disabled={busy || !canPause(print?.status)}
            onClick={() => void act(api.pause)}
            className="flex-1 rounded-lg border border-slate-600 px-4 py-3 disabled:opacity-40"
          >
            Pause
          </button>
          <button
            type="button"
            disabled={busy || !canResume(print?.status)}
            onClick={() => void act(api.resume)}
            className="flex-1 rounded-lg border border-slate-600 px-4 py-3 disabled:opacity-40"
          >
            Resume
          </button>
          <button
            type="button"
            disabled={busy || !canStop(print?.status)}
            onClick={confirmStop}
            className="flex-1 rounded-lg border border-red-500/50 px-4 py-3 text-red-300 disabled:opacity-40"
          >
            Stop
          </button>
        </section>
      </div>
    </main>
  );
}

/**
 * The printer's own thumbnail of the print - it keeps one per task, so this
 * works however the print was started. Nothing, not a broken image, if not.
 */
function Preview({ taskId }: { taskId: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return (
    <img
      src={`/api/print/thumbnail?task=${encodeURIComponent(taskId)}`}
      alt="Preview of the print"
      onError={() => setMissing(true)}
      className="h-20 w-28 shrink-0 rounded bg-black object-contain sm:h-28 sm:w-36"
    />
  );
}
