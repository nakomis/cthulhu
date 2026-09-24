export interface Range {
  start: number;
  end: number;
  /** false for a plain, unranged request - the whole file, status 200. */
  partial: boolean;
}

/**
 * A single HTTP Range header (`bytes=start-end`), against a known file size.
 *
 * Shared by the camera service (its own finished time-lapses) and the
 * server (archived ones on the share), so a browser's <video> can seek either
 * way with the same 206/Content-Range/416 behaviour. Multi-range requests
 * (`bytes=0-1,4-5`) are deliberately not supported - a single <video> element
 * never sends one, and answering with the whole file for a multi-range
 * request is a normal, spec-compliant fallback.
 */
export function parseRange(range: string | undefined, size: number): Range | 'invalid' {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
  if (!match || (!match[1] && !match[2])) return { start: 0, end: size - 1, partial: false };

  let start: number;
  let end: number;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    // A suffix range, "bytes=-500": the last 500 bytes.
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end, partial: true };
}
