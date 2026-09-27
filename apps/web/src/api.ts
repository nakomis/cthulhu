export interface PrinterView {
  connected: boolean;
  address: string | null;
  mainboardId: string | null;
  machineStatus: number[];
  print: {
    status: number | undefined;
    statusLabel: string;
    filename: string | undefined;
    currentLayer: number | undefined;
    totalLayer: number | undefined;
    progressPercent: number | undefined;
    remainingMs: number | undefined;
    /** The printer's estimate of the whole print, in ms. */
    totalMs?: number | undefined;
    errorNumber: number | undefined;
    taskId: string | undefined;
  };
  releaseFilmState: number | undefined;
  /** Layers printed on the current film. */
  releaseFilmUses?: number | undefined;
  /** Recommended film life in layers. */
  releaseFilmMax?: number | undefined;
  attributes: { machineName?: string; xyzSize?: string } | undefined;
  updatedAt: string | undefined;
}

export interface PrintRecord {
  id: number;
  taskId: string | null;
  filename: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: string;
  totalLayer: number | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface PrinterFile {
  /** Full path, which is what starting a print takes. */
  path: string;
  name: string;
  storage: 'local' | 'usb';
  /** Folder relative to the storage root; '' at the top. */
  folder: string;
}

/** Read from the file's own header on the printer. */
export interface FileMeta {
  layerCount: number;
  layerHeightMm: number;
  /** The slicer's estimate, in seconds. */
  printTimeS: number;
  preview: boolean;
}

export interface UploadProgress {
  filename: string;
  sent: number;
  total: number;
  percent: number;
  elapsedMs: number;
  /** Absent until two packets have landed; see the server's reasoning. */
  remainingMs?: number;
}

export const api = {
  fileMeta: async (path: string): Promise<FileMeta | undefined> => {
    const res = await fetch(`/api/files/meta?path=${encodeURIComponent(path)}`);
    return res.ok ? ((await res.json()) as FileMeta) : undefined;
  },
  files: async (): Promise<PrinterFile[]> => {
    const res = await fetch('/api/files');
    if (!res.ok) return [];
    // The server walks /local and the USB stick and flattens the printer's
    // nested replies, so this is already a plain list.
    const body = (await res.json()) as { files?: PrinterFile[] };
    return body.files ?? [];
  },
  startPrint: (filename: string) =>
    fetch('/api/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename }),
    }).then((r) => json(r)),
  upload: (file: File) =>
    fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name },
      body: file,
    }).then((r) => json<{ filename: string; md5: string; size: number }>(r)),
  status: () => fetch('/api/status').then((r) => json<PrinterView>(r)),
  history: () => fetch('/api/history').then((r) => json<{ prints: PrintRecord[] }>(r)),
  pause: () => fetch('/api/control/pause', { method: 'POST' }).then((r) => json(r)),
  resume: () => fetch('/api/control/resume', { method: 'POST' }).then((r) => json(r)),
  /** Stop always sends the confirmation flag; the UI asks the human first. */
  stop: () =>
    fetch('/api/control/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).then((r) => json(r)),
  /**
   * Delete files from the printer. Batched, because the printer's own command
   * is (Cmd 259), and confirmed for the same reason stop is: there is no undo
   * and the printer has no recycle bin. The UI asks the human first.
   */
  /**
   * How far the upload in progress has got, or undefined when none is running.
   *
   * Polled rather than measured in the browser: XMLHttpRequest's upload progress
   * only covers browser -> cthulhu, which is local and near-instant, so it would
   * read 100% within a second and then sit there. The slow leg is cthulhu to the
   * printer, and only the server can see it.
   */
  uploadProgress: async (): Promise<UploadProgress | undefined> => {
    const res = await fetch('/api/upload/progress');
    // 204 means nothing is uploading, which is the normal case, not an error.
    if (res.status === 204 || !res.ok) return undefined;
    return (await res.json()) as UploadProgress;
  },
  /**
   * Abandon the upload in progress. Answers 200 even if the printer could not
   * be told, with printerNotified false: the local side of a cancel — stopping
   * sending — is the part that frees the link, and it always works.
   */
  cancelUpload: () =>
    fetch('/api/upload/cancel', { method: 'POST' }).then((r) =>
      json<{ cancelled: string; printerNotified: boolean; printerError?: string }>(r),
    ),
  deleteFiles: (paths: string[]) =>
    fetch('/api/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: paths, confirm: true }),
    }).then((r) => json<{ deleted: string[]; files?: PrinterFile[] }>(r)),
};
