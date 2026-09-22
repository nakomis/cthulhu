import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type PrinterFile } from './api.js';

export interface FilesProps {
  /** Injected in tests. */
  listFiles?: () => Promise<PrinterFile[]>;
  uploadFile?: (file: File) => Promise<unknown>;
  startPrint?: (filename: string) => Promise<unknown>;
  onChanged?: () => void;
  /** Whether a print is already running; starting another would be refused. */
  busy?: boolean;
}

export function Files({
  listFiles = api.files,
  uploadFile = api.upload,
  startPrint = api.startPrint,
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
    setMessage(undefined);
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
            <li key={f.name} className="flex items-center justify-between gap-2">
              <span className="truncate text-sm">{f.name}</span>
              <button
                type="button"
                disabled={working || busy}
                onClick={() => void onPrint(f.name)}
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
