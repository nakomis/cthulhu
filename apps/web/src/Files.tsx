import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type FileMeta, type PrinterFile } from './api.js';

export interface FilesProps {
  /** Injected in tests. */
  listFiles?: () => Promise<PrinterFile[]>;
  uploadFile?: (file: File) => Promise<unknown>;
  startPrint?: (filename: string) => Promise<unknown>;
  fileMeta?: (path: string) => Promise<FileMeta | undefined>;
  onChanged?: () => void;
  /** Whether a print is already running; starting another would be refused. */
  busy?: boolean;
}

export function Files({
  listFiles = api.files,
  uploadFile = api.upload,
  startPrint = api.startPrint,
  fileMeta = api.fileMeta,
  onChanged,
  busy = false,
}: FilesProps) {
  const [files, setFiles] = useState<PrinterFile[]>([]);
  const [message, setMessage] = useState<string | undefined>();
  const [working, setWorking] = useState(false);
  const input = useRef<HTMLInputElement>(null);

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

  const onUpload = async (file: File) => {
    setWorking(true);
    // Over the printer's WiFi an upload runs at roughly 100 KB/s: 13 MB took
    // two and a half minutes, with nothing on screen to say it was happening.
    setMessage(`Uploading ${file.name}${uploadEstimate(file.size)}…`);
    try {
      await uploadFile(file);
      setMessage(`Uploaded ${file.name}`);
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
        <p role="status" className="mt-2 text-sm text-slate-300">
          {message}
        </p>
      ) : null}

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
              <button
                type="button"
                disabled={working || busy}
                onClick={() => void onPrint(f.path)}
                className="shrink-0 rounded border border-tentacle/50 px-3 py-1 text-sm text-tentacle disabled:opacity-40"
              >
                Print
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** " (about 2 min)" for a 13 MB file, from what the real printer managed. */
export function uploadEstimate(bytes: number): string {
  const seconds = Math.round((bytes / (1024 * 1024)) * 11);
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
