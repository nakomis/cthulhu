/**
 * The most recent complete JPEG in an MJPEG byte stream.
 *
 * Fed the upstream's chunks as they pass; keeps only the last whole frame,
 * found by its JPEG start (FF D8) and end (FF D9) markers rather than by the
 * multipart headers, so it does not care which muxer wrote the stream.
 */
export class LatestFrame {
  private pending: Buffer = Buffer.alloc(0);
  private frame: { jpeg: Buffer; at: number } | undefined;
  /** A stream that never closes a frame must not grow without bound. */
  private readonly maxPending: number;

  constructor({ maxPending = 8 * 1024 * 1024 }: { maxPending?: number } = {}) {
    this.maxPending = maxPending;
  }

  push(chunk: Buffer, now = Date.now()): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      const start = this.pending.indexOf(SOI);
      if (start < 0) {
        this.pending = Buffer.alloc(0);
        return;
      }
      const end = this.pending.indexOf(EOI, start + 2);
      if (end < 0) {
        this.pending = this.pending.subarray(start);
        if (this.pending.length > this.maxPending) this.pending = Buffer.alloc(0);
        return;
      }
      this.frame = { jpeg: Buffer.from(this.pending.subarray(start, end + 2)), at: now };
      this.pending = this.pending.subarray(end + 2);
    }
  }

  /** The latest frame, if it is no older than `maxAgeMs`. */
  latest(maxAgeMs = Number.POSITIVE_INFINITY, now = Date.now()): Buffer | undefined {
    if (!this.frame || now - this.frame.at > maxAgeMs) return undefined;
    return this.frame.jpeg;
  }

  clear(): void {
    this.pending = Buffer.alloc(0);
    this.frame = undefined;
  }
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
