import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type FileMeta, type PrinterFile, type UploadProgress } from './api.js';

export interface FilesProps {
  /** Injected in tests. */
  listFiles?: () => Promise<PrinterFile[]>;
  uploadFile?: (file: File) => Promise<unknown>;
  startPrint?: (filename: string) => Promise<unknown>;
  deleteFiles?: (paths: string[]) => Promise<unknown>;
  cancelUpload?: () => Promise<unknown>;
  uploadProgress?: () => Promise<UploadProgress | undefined>;
  /** Poll period for upload progress. Shortened in tests. */
  progressIntervalMs?: number;
  fileMeta?: (path: string) => Promise<FileMeta | undefined>;
  onChanged?: () => void;
  /** Whether a print is already running; starting another would be refused. */
  busy?: boolean;
}

export function Files({
  listFiles = api.files,
  uploadFile = api.upload,
  startPrint = api.startPrint,
  deleteFiles = api.deleteFiles,
  cancelUpload = api.cancelUpload,
  uploadProgress = api.uploadProgress,
  progressIntervalMs = 1000,
  fileMeta = api.fileMeta,
  onChanged,
  busy = false,
}: FilesProps) {
  const [files, setFiles] = useState<PrinterFile[]>([]);
  const [message, setMessage] = useState<string | undefined>();
  const [working, setWorking] = useState(false);
  /**
   * Path awaiting a second click. Deletion is irreversible and the printer has
   * no recycle bin, so Delete arms and a second press commits — rather than a
   * window.confirm, which is a modal the TV's browser handles badly and which
   * tests can only reach by stubbing a global.
   */
  const [confirming, setConfirming] = useState<string | undefined>();
  /** True only while an upload is running, so Cancel is offered then and not
   *  during a delete, which is far too quick to cancel usefully. */
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | undefined>();
  const input = useRef<HTMLInputElement>(null);

  /**
   * Poll the server for how far the upload has got, only while one is running.
   *
   * The server is the only thing that can see this: the browser's own upload
   * finished seconds ago, and the minutes that follow are cthulhu feeding the
   * printer.
   */
  useEffect(() => {
    if (!uploading) {
      setProgress(undefined);
      return;
    }
    let live = true;
    const tick = async () => {
      try {
        const p = await uploadProgress();
        if (live && p) setProgress(p);
      } catch {
        // A failed poll is not worth surfacing: the upload itself reports its
        // own outcome, and a missing bar is better than a false error.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), progressIntervalMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [uploading, uploadProgress, progressIntervalMs]);

  const refresh = useCallback(async () => {
    try {
      setFiles(await listFiles());
    } catch {
      // A printer that is off is normal; an empty list says as much.
      setFiles([]);
    }
  }, [listFiles]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCancelUpload = async () => {
    setMessage('Cancelling…');
    try {
      const res = (await cancelUpload()) as
        | { cancelled?: string; printerNotified?: boolean }
        | undefined;
      const name = res?.cancelled ?? 'the upload';
      // Worth saying when the printer was not told: it may be left holding a
      // partial file, which the next upload of that name will overwrite.
      setMessage(
        res?.printerNotified === false
          ? `Cancelled ${name} — the printer was not told, so a partial file may remain`
          : `Cancelled ${name}`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const onUpload = async (file: File) => {
    setWorking(true);
    setUploading(true);
    // Over the printer's WiFi an upload runs at roughly 100 KB/s: 13 MB took
    // two and a half minutes, with nothing on screen to say it was happening.
    setMessage(`Uploading ${file.name}${uploadEstimate(file.size)}…`);
    try {
      await uploadFile(file);
      setMessage(`Uploaded ${file.name}`);
      await refresh();
    } catch (err) {
      // A cancel has already put its own message up; do not overwrite it with
      // the upload's rejection, which reads as a failure the user did not cause.
      setMessage((current) =>
        current?.startsWith('Cancelled')
          ? current
          : err instanceof Error
            ? err.message
            : String(err),
      );
      // Re-read the list even on failure. "Failed" can be a false negative —
      // the printer is slower to list a large file than we are to give up on
      // it — and leaving the list stale made a working upload look doubly
      // broken: the file was there, just invisible until a manual refresh.
      // The printer is the authority on what it holds, not our verdict.
      await refresh();
    } finally {
      setWorking(false);
      setUploading(false);
    }
  };

  const onDelete = async (path: string, name: string) => {
    setConfirming(undefined);
    setWorking(true);
    setMessage(`Deleting ${name}…`);
    try {
      await deleteFiles([path]);
      setMessage(`Deleted ${name}`);
      // The printer pushes no new listing after a delete, so ask for one.
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const onPrint = async (filename: string) => {
    setWorking(true);
    setMessage(undefined);
    try {
      await startPrint(filename);
      setMessage(`Started ${filename}`);
      onChanged?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="rounded-lg border border-slate-700 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wider text-slate-400">Files</h2>
        <button
          type="button"
          disabled={working}
          onClick={() => input.current?.click()}
          className="rounded border border-slate-600 px-3 py-1 text-sm disabled:opacity-40"
        >
          Upload
        </button>
        <input
          ref={input}
          type="file"
          accept=".goo,.ctb"
          data-testid="file-input"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onUpload(file);
            e.target.value = '';
          }}
        />
      </div>

      {message ? (
        <div className="mt-2 flex items-center gap-3">
          <p role="status" className="text-sm text-slate-300">
            {message}
          </p>
          {uploading ? (
            <button
              type="button"
              aria-label="Cancel upload"
              onClick={() => void onCancelUpload()}
              className="shrink-0 rounded border border-slate-600 px-2 py-0.5 text-xs text-slate-400"
            >
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}

      {uploading && progress ? <UploadBar progress={progress} /> : null}

      {files.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No files on the printer.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {files.map((f) => (
            <li key={f.path} className="flex items-center justify-between gap-3">
              <FilePreview path={f.path} name={f.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{f.name}</span>
                <span className="block truncate text-xs text-slate-500">
                  {f.storage === 'usb' ? 'USB stick' : 'Printer'}
                  {f.folder ? ` · ${f.folder}` : ''}
                  <FileDetails path={f.path} fileMeta={fileMeta} />
                </span>
              </span>
              {confirming === f.path ? (
                <>
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => void onDelete(f.path, f.name)}
                    className="shrink-0 rounded border border-red-500 bg-red-500/10 px-3 py-1 text-sm text-red-300 disabled:opacity-40"
                  >
                    Delete for good
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(undefined)}
                    className="shrink-0 rounded border border-slate-600 px-3 py-1 text-sm disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={working || busy}
                    onClick={() => void onPrint(f.path)}
                    className="shrink-0 rounded border border-tentacle/50 px-3 py-1 text-sm text-tentacle disabled:opacity-40"
                  >
                    Print
                  </button>
                  <button
                    type="button"
                    disabled={working}
                    aria-label={`Delete ${f.name}`}
                    onClick={() => setConfirming(f.path)}
                    className="shrink-0 rounded border border-slate-600 px-3 py-1 text-sm text-slate-400 disabled:opacity-40"
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * How far the upload has got, from the server's own count of accepted bytes.
 *
 * A progressbar role rather than a bare div, so it is announced; and the
 * numbers are given as text too, because a bar alone cannot say "2 min left".
 */
function UploadBar({ progress }: { progress: UploadProgress }) {
  const { percent, sent, total, remainingMs } = progress;
  return (
    <div className="mt-2">
      <div
        role="progressbar"
        aria-label={`Uploading ${progress.filename}`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full overflow-hidden rounded bg-slate-800"
      >
        <div
          className="h-full rounded bg-tentacle transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {`${percent}% · ${formatMegabytes(sent)} of ${formatMegabytes(total)}`}
        {/* Nothing until the server has two packets to work from: it will not
            guess, and a wrong ETA is worse than none. */}
        {remainingMs !== undefined ? ` · ${formatRemaining(remainingMs)}` : ''}
      </p>
    </div>
  );
}

/**
 * "about 4 min left", or "less than a minute left" near the end.
 *
 * formatDuration rounds to whole minutes, so the last thirty seconds of a
 * transfer would otherwise read "0 m left".
 */
export function formatRemaining(remainingMs: number): string {
  const seconds = remainingMs / 1000;
  if (seconds < 45) return 'less than a minute left';
  return `about ${formatDuration(seconds)} left`;
}

export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/**
 * " (about 3 min)" for a 216 MB file, from what the real printer managed
 * (about 1.3 MB/s). An earlier 11 s/MB guess came from one slow upload and
 * promised 38 minutes for a transfer that took under three.
 */
export function uploadEstimate(bytes: number): string {
  const seconds = Math.round((bytes / (1024 * 1024)) * 0.8);
  if (seconds < 20) return '';
  return seconds < 90 ? ' (about a minute)' : ` (about ${Math.round(seconds / 60)} min)`;
}

/**
 * The slicer's preview, read from the file on the printer - so it is there
 * for every .goo, whoever put it there. Nothing at all (not a broken-image
 * icon) for a file without one: a .ctb, say.
 */
function FilePreview({ path, name }: { path: string; name: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <span className="size-12 shrink-0 rounded bg-slate-800" />;
  return (
    <img
      src={`/api/files/preview?path=${encodeURIComponent(path)}`}
      alt={`Preview of ${name}`}
      loading="lazy"
      onError={() => setMissing(true)}
      className="size-12 shrink-0 rounded bg-black object-contain"
    />
  );
}

/** " · 893 layers · about 1 h 28 m", once the file's header has been read. */
function FileDetails({
  path,
  fileMeta,
}: {
  path: string;
  fileMeta: (path: string) => Promise<FileMeta | undefined>;
}) {
  const [meta, setMeta] = useState<FileMeta | undefined>();
  useEffect(() => {
    let live = true;
    fileMeta(path)
      .then((m) => {
        if (live) setMeta(m);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path, fileMeta]);
  if (!meta) return null;
  return (
    <>
      {` · ${meta.layerCount} layers`}
      {meta.printTimeS > 0 ? ` · about ${formatDuration(meta.printTimeS)}` : ''}
    </>
  );
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} m` : `${m} m`;
}
