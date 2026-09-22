/** Print status codes, mirrored from @cthulhu/sdcp. */
export const PRINT_STATUS_LABELS: Record<number, string> = {
  0: 'Idle',
  1: 'Homing',
  2: 'Dropping',
  3: 'Exposing',
  4: 'Lifting',
  5: 'Pausing',
  6: 'Paused',
  7: 'Stopping',
  8: 'Stopped',
  9: 'Complete',
  10: 'Checking file',
};

export function printStatusLabel(code: number): string {
  return PRINT_STATUS_LABELS[code] ?? `Unknown (${code})`;
}

/** Percentage complete, clamped, and safe when the printer reports no layers. */
export function layerProgress(current: number, total: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((current / total) * 100)));
}

/** Format a remaining-time estimate as `2h 05m`. */
export function formatEta(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '—';
  const totalMinutes = Math.round(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

/** Whether a status code means a print is actively running. */
export function isActive(code: number | undefined): boolean {
  return code !== undefined && code >= 1 && code <= 5;
}

/** Release film health. 1 is healthy; anything else is worth shouting about. */
export function releaseFilmLabel(state: number | undefined): string {
  if (state === undefined) return 'Unknown';
  return state === 1 ? 'OK' : `Check film (${state})`;
}
