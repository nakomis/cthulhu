import { PassThrough, type Readable } from 'node:stream';

export interface CameraProxyOptions {
  /** Opens the upstream MJPEG stream. Injected so tests need no printer. */
  openUpstream: () => Promise<Readable>;
  /** Called when the last viewer leaves, to release the single slot. */
  onIdle?: () => void | Promise<void>;
}

/**
 * Multiplexes the printer's single MJPEG stream to many browsers.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MaximumVideoStreamAllowed is 1. This is not a tuning parameter.
 *
 * The server must hold exactly ONE upstream connection and fan it out, and it
 * must DROP that connection when nobody is watching - otherwise the Elegoo
 * phone app can never connect, because we are holding the only slot.
 * ────────────────────────────────────────────────────────────────────────────
 */
export class CameraProxy {
  private upstream: Readable | undefined;
  private readonly viewers = new Set<PassThrough>();
  private opening: Promise<void> | undefined;
  private readonly openUpstream: () => Promise<Readable>;
  private readonly onIdle: (() => void | Promise<void>) | undefined;

  constructor(options: CameraProxyOptions) {
    this.openUpstream = options.openUpstream;
    this.onIdle = options.onIdle;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  get upstreamOpen(): boolean {
    return this.upstream !== undefined;
  }

  async addViewer(): Promise<PassThrough> {
    const viewer = new PassThrough();
    this.viewers.add(viewer);

    viewer.on('close', () => {
      this.viewers.delete(viewer);
      if (this.viewers.size === 0) void this.closeUpstream();
    });

    await this.ensureUpstream();
    return viewer;
  }

  private async ensureUpstream(): Promise<void> {
    if (this.upstream) return;
    // Concurrent viewers must not each open a connection - there is only one
    // slot, so the second would be refused by the printer.
    if (this.opening) return this.opening;

    this.opening = (async () => {
      const stream = await this.openUpstream();
      this.upstream = stream;
      stream.on('data', (chunk: Buffer) => {
        for (const v of this.viewers) v.write(chunk);
      });
      const drop = () => {
        this.upstream = undefined;
        for (const v of this.viewers) v.end();
        this.viewers.clear();
      };
      stream.on('end', drop);
      stream.on('error', drop);
    })();

    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  private async closeUpstream(): Promise<void> {
    const stream = this.upstream;
    this.upstream = undefined;
    if (stream) {
      stream.destroy();
      await this.onIdle?.();
    }
  }

  /** Shut everything down, e.g. on server close. */
  async close(): Promise<void> {
    for (const v of this.viewers) v.end();
    this.viewers.clear();
    await this.closeUpstream();
  }
}
