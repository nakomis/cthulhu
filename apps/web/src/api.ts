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
    errorNumber: number | undefined;
    taskId: string | undefined;
  };
  releaseFilmState: number | undefined;
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

export const api = {
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
