import { useEffect, useRef, useState } from 'react';

export interface LayerProps {
  /** The printer's CurrentLayer: layers done, so also the one being exposed. */
  layer: number;
  totalLayer: number | undefined;
  /** Injected in tests. */
  fetchLayer?: (layer: number) => Promise<Response>;
}

const defaultFetch = (layer: number) => fetch(`/api/print/layer?layer=${layer}`);

/**
 * The layer being printed, drawn from the print file itself, like the
 * Elegoo app shows it.
 *
 * The previous image stays up until the next has arrived, so the picture
 * steps from layer to layer rather than flashing blank every few seconds.
 * While cthulhu is still fetching the print file from the printer, it says
 * so, with how far it has got.
 */
export function Layer({ layer, totalLayer, fetchLayer = defaultFetch }: LayerProps) {
  const [src, setSrc] = useState<string | undefined>();
  const [shown, setShown] = useState<number | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const urls = useRef<string[]>([]);

  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetchLayer(layer);
        if (!live) return;
        if (res.status === 202) {
          const body = (await res.json()) as { received?: number; total?: number };
          const pct =
            body.total && body.received !== undefined
              ? ` ${Math.floor((body.received / body.total) * 100)}%`
              : '';
          setNote(`Fetching the print file from the printer…${pct}`);
          retry = setTimeout(load, 1500);
          return;
        }
        if (!res.ok) {
          setNote('No layer image for this print.');
          return;
        }
        const url = URL.createObjectURL(await res.blob());
        if (!live) {
          URL.revokeObjectURL(url);
          return;
        }
        urls.current.push(url);
        setSrc(url);
        setShown(layer);
        setNote(undefined);
        // Keep the one on screen and the one replacing it; free the rest.
        while (urls.current.length > 2) URL.revokeObjectURL(urls.current.shift() as string);
      } catch {
        if (live) setNote('No layer image for this print.');
      }
    };
    void load();
    return () => {
      live = false;
      if (retry) clearTimeout(retry);
    };
  }, [layer, fetchLayer]);

  // Mounted once per print (keyed by task), so leaving is the only cleanup.
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current = [];
    },
    [],
  );

  return (
    <section className="rounded-lg border border-slate-700 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs uppercase tracking-wider text-slate-400">Layer</h2>
        {shown !== undefined ? (
          // "printing", because Progress counts layers FINISHED: while it says
          // 447, layer 448 is the one on the screen.
          <span className="text-sm text-slate-400">
            printing {shown + 1}
            {totalLayer ? ` of ${totalLayer}` : ''}
          </span>
        ) : null}
      </div>
      {src ? (
        <img
          src={src}
          alt={`Layer ${(shown ?? 0) + 1} of the print`}
          className="mt-3 w-full rounded bg-black"
        />
      ) : null}
      {note ? (
        <p role="status" className="mt-3 text-sm text-slate-400">
          {note}
        </p>
      ) : null}
    </section>
  );
}
