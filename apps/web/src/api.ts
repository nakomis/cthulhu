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
};
