import { useState } from 'react';

/**
 * The printer's camera, proxied by the server.
 *
 * An <img> pointed at a multipart/x-mixed-replace endpoint is the standard way
 * to show MJPEG, and the browser handles the frame boundaries. Mounting it
 * only when shown matters: the server opens the single upstream slot on the
 * first viewer and releases it when the last leaves, so an always-mounted
 * <img> would hold the printer's only stream open permanently and lock the
 * Elegoo app out.
 */
export function Camera() {
  const [showing, setShowing] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <section className="rounded-lg border border-slate-700 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wider text-slate-400">Camera</h2>
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setShowing((s) => !s);
          }}
          className="rounded border border-slate-600 px-3 py-1 text-sm"
        >
          {showing ? 'Stop' : 'Watch'}
        </button>
      </div>

      {showing ? (
        failed ? (
          <p role="alert" className="mt-3 text-sm text-amber-300">
            Camera unavailable. The printer allows one stream at a time — check nothing else is
            watching.
          </p>
        ) : (
          <img
            src="/api/camera/stream"
            alt="Printer camera"
            className="mt-3 w-full rounded bg-black"
            onError={() => setFailed(true)}
          />
        )
      ) : (
        <p className="mt-3 text-sm text-slate-500">
          Not watching. The printer allows only one stream, so it is released when nobody is
          looking.
        </p>
      )}
    </section>
  );
}
