import { useEffect, useRef, useState } from 'react';
import { Lightbox } from './Lightbox.js';

export interface LayerProps {
  /** The printer's CurrentLayer: layers done, so also the one being exposed. */
  layer: number;
  totalLayer: number | undefined;
  /** Injected in tests. `scale` is left out for the server's usual 852 x 432. */
  fetchLayer?: (layer: number, scale?: number) => Promise<Response>;
}

/** The URL of a layer's image; no `scale` means the server's default (10). */
export const layerUrl = (layer: number, scale?: number) =>
  `/api/print/layer?layer=${layer}${scale === undefined ? '' : `&scale=${scale}`}`;

const defaultFetch = (layer: number, scale?: number) => fetch(layerUrl(layer, scale));

/**
 * How far the lightbox shrinks the 8520 x 4320 layer: 4260 x 2160, more than
 * any screen shows across, in about 100 ms and 20-110 KB of PNG for real
 * files - against 350-450 ms and up to 200 KB for every pixel (scale 1),
 * which stays a link of its own.
 */
export const LIGHTBOX_SCALE = 2;

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

  // A compact figure for the Status box, beside the preview: the image,
  // what it is, and while there is none yet, why.
  return (
    <figure className="flex shrink-0 flex-col items-center">
      {src && shown !== undefined ? (
        <Lightbox
          name={`layer ${shown + 1} of the print`}
          caption={`Layer ${shown + 1}${totalLayer ? ` of ${totalLayer}` : ''}`}
          full={<LayerFull layer={shown} smallSrc={src} fetchLayer={fetchLayer} />}
          actions={
            <a
              href={layerUrl(shown, 1)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 underline-offset-2 hover:underline"
            >
              Open full resolution
            </a>
          }
        >
          <img
            src={src}
            alt={`Layer ${shown + 1} of the print`}
            className="h-20 rounded bg-black sm:h-28"
          />
        </Lightbox>
      ) : null}
      {note ? (
        <p
          role="status"
          className="flex h-20 w-40 items-center rounded bg-black p-2 text-center text-xs text-slate-400 sm:h-28 sm:w-56"
        >
          {note}
        </p>
      ) : null}
      {shown !== undefined ? (
        // "printing", because Progress counts layers FINISHED: while it says
        // 447, layer 448 is the one on the screen.
        <figcaption className="mt-1 text-xs text-slate-400">
          printing {shown + 1}
          {totalLayer ? ` of ${totalLayer}` : ''}
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * The lightbox's layer: the one that was on screen when it opened (the
 * Lightbox holds it still while the print moves on underneath).
 *
 * The small image stands in, scaled up, until the big one has arrived - no
 * blank box while it renders. If the big one cannot be had, the small one
 * stays, with a note saying why.
 */
function LayerFull({
  layer,
  smallSrc,
  fetchLayer,
}: {
  layer: number;
  smallSrc: string;
  fetchLayer: (layer: number, scale?: number) => Promise<Response>;
}) {
  const [bigSrc, setBigSrc] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>('Loading the full-size layer…');

  useEffect(() => {
    let live = true;
    let url: string | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetchLayer(layer, LIGHTBOX_SCALE);
        if (!live) return;
        if (res.status === 202) {
          setNote('Fetching the print file from the printer…');
          retry = setTimeout(load, 1500);
          return;
        }
        if (!res.ok) {
          setNote('The full-size layer is not available.');
          return;
        }
        const blob = await res.blob();
        if (!live) return;
        url = URL.createObjectURL(blob);
        setBigSrc(url);
        setNote(undefined);
      } catch {
        if (live) setNote('The full-size layer is not available.');
      }
    };
    void load();
    return () => {
      live = false;
      if (retry) clearTimeout(retry);
      if (url) URL.revokeObjectURL(url);
    };
  }, [layer, fetchLayer]);

  return (
    <div className="relative">
      <img
        src={bigSrc ?? smallSrc}
        alt={`Layer ${layer + 1} of the print, ${bigSrc ? 'full size' : 'small while the full size loads'}`}
        data-scale={bigSrc ? LIGHTBOX_SCALE : 10}
        // Sized from the LCD's shape, so the small stand-in fills the same
        // box as the big one and nothing jumps when it arrives.
        style={{
          width: 'min(95vw, calc((90vh - 4rem) * 8520 / 4320))',
          aspectRatio: '8520 / 4320',
        }}
        className="rounded bg-black object-contain"
      />
      {note ? (
        <p
          role="status"
          className="absolute inset-x-0 bottom-0 rounded-b bg-slate-950/70 px-2 py-1 text-center text-xs text-slate-300"
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}
