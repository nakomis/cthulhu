import { useEffect, useState } from 'react';

export interface TimelapseEntry {
  id: string;
  state: 'recording' | 'assembling' | 'ready' | 'failed';
  frames: number;
  startedAt: string;
  filename: string | null;
  error?: string;
}

export interface TimelapsesProps {
  /** Injected in tests. */
  listTimelapses?: () => Promise<TimelapseEntry[]>;
  refreshMs?: number;
}

const defaultList = async (): Promise<TimelapseEntry[]> => {
  const res = await fetch('/api/timelapses');
  return res.ok ? ((await res.json()) as TimelapseEntry[]) : [];
};

const STATE_LABEL: Record<TimelapseEntry['state'], string> = {
  recording: 'recording',
  assembling: 'making the video…',
  ready: '',
  failed: 'failed',
};

/**
 * Every print's time-lapse: one frame at the top of each layer, made on the
 * camera service. Videos load only when opened - a dozen of them is a lot
 * of megabytes to fetch just to show a list.
 */
export function Timelapses({ listTimelapses = defaultList, refreshMs = 30_000 }: TimelapsesProps) {
  const [items, setItems] = useState<TimelapseEntry[]>([]);
  const [open, setOpen] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    const load = () =>
      listTimelapses()
        .then((list) => {
          if (live) setItems(list);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, refreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [listTimelapses, refreshMs]);

  if (items.length === 0) return null;
  return (
    <section className="rounded-lg border border-slate-700 p-4">
      <h2 className="text-xs uppercase tracking-wider text-slate-400">Time-lapses</h2>
      <ul className="mt-3 space-y-3">
        {items.map((t) => {
          const name = t.filename?.split('/').pop() ?? 'Print';
          const when = new Date(t.startedAt).toLocaleString('en-GB', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          });
          const state = STATE_LABEL[t.state];
          return (
            <li key={t.id}>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  disabled={t.state !== 'ready'}
                  onClick={() => setOpen(open === t.id ? undefined : t.id)}
                  className="min-w-0 text-left disabled:cursor-default"
                >
                  <span className="block truncate text-sm">{name}</span>
                  <span className="block text-xs text-slate-500">
                    {when} · {t.frames} layers{state ? ` · ${state}` : ''}
                  </span>
                </button>
                {t.state === 'ready' ? (
                  <a
                    href={`/api/timelapses/${t.id}.mp4`}
                    download={`${name.replace(/\.[^.]+$/, '')}-timelapse.mp4`}
                    className="shrink-0 rounded border border-slate-600 px-3 py-1 text-sm"
                  >
                    Download
                  </a>
                ) : null}
              </div>
              {open === t.id ? (
                // biome-ignore lint/a11y/useMediaCaption: a time-lapse has no speech to caption
                <video
                  src={`/api/timelapses/${t.id}.mp4`}
                  controls
                  autoPlay
                  playsInline
                  className="mt-2 w-full rounded bg-black"
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
