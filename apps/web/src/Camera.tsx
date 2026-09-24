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
  // The printer's camera is H.264 over RTSP, and a decoder cannot produce a
  // picture until the next keyframe. With a long GOP that is several seconds
  // of an open, healthy, SILENT stream - no error fires, so without this the
  // box sits blank and reads as broken. Cleared by the first frame's onLoad.
  const [firstFrame, setFirstFrame] = useState(false);

  return (
    <section className="rounded-lg border border-slate-700 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wider text-slate-400">Camera</h2>
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setFirstFrame(false);
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
            Camera unavailable. The printer may have refused the stream, or it could not be
            converted; cthulhu&rsquo;s log says which.
          </p>
        ) : (
          <div className="relative mt-3">
            {firstFrame ? null : (
              <p
                role="status"
                className="absolute inset-0 flex items-center justify-center text-sm text-slate-400"
              >
                Waiting for the camera&rsquo;s first keyframe&hellip;
              </p>
            )}
            <img
              src="/api/camera/stream"
              alt="Printer camera"
              className="aspect-video w-full rounded bg-black"
              onLoad={() => setFirstFrame(true)}
              onError={() => setFailed(true)}
            />
          </div>
        )
      ) : (
        <p className="mt-3 text-sm text-slate-500">
          Not watching. The stream is released when nobody is looking, so the Elegoo app can still
          connect.
        </p>
      )}
    </section>
  );
}
