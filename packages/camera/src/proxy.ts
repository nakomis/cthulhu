import { PassThrough, type Readable } from 'node:stream';

/**
 * A live upstream connection plus the means to genuinely abort it.
 *
 * `abort` exists because destroying the Readable is NOT enough: a stream from
 * `Readable.fromWeb(response.body)` keeps the underlying HTTP connection open,
 * so the printer goes on counting the viewer and refuses everyone else. Found
 * by running the real proxy against the fake printer and watching it answer
 * 503 to a direct viewer long after the last browser had gone.
 */
export interface UpstreamHandle {
  stream: Readable;
  abort: () => void;
}

export interface CameraProxyOptions {
  /** Opens the upstream MJPEG stream. Injected so tests need no printer. */
  openUpstream: () => Promise<UpstreamHandle>;
  /**
   * Called before the upstream is opened for the first viewer.
   *
   * Needed because onIdle sends Cmd 386 to DISABLE the stream, and without a
   * matching enable the camera works exactly once and is then refused
   * forever. Found by clicking Watch twice in the browser.
   */
  onActive?: () => void | Promise<void>;
  /** Called when the last viewer leaves, to release the single slot. */
  onIdle?: () => void | Promise<void>;
}

/**
 * Where each part of the multipart stream begins. Every upstream uses the
 * boundary `frame`: ffmpeg is run with `-boundary_tag frame`, the fake printer
 * serves it, and the responses to viewers declare it.
 */
const PART_START = Buffer.from('--frame\r\n');

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
  private upstream: UpstreamHandle | undefined;
  private readonly viewers = new Set<PassThrough>();
  /** Viewers that have been started at a part boundary; see deliver(). */
  private readonly aligned = new WeakSet<PassThrough>();
  private readonly tails = new WeakMap<PassThrough, Buffer>();
  private opening: Promise<void> | undefined;
  private readonly openUpstream: () => Promise<UpstreamHandle>;
  private readonly onActive: (() => void | Promise<void>) | undefined;
  private readonly onIdle: (() => void | Promise<void>) | undefined;

  constructor(options: CameraProxyOptions) {
    this.openUpstream = options.openUpstream;
    this.onActive = options.onActive;
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
      // Re-enable the stream before connecting; onIdle turned it off.
      await this.onActive?.();
      const handle = await this.openUpstream();
      this.upstream = handle;
      handle.stream.on('data', (chunk: Buffer) => {
        for (const v of this.viewers) this.deliver(v, chunk);
      });
      // The upstream died on its own (ffmpeg exited, or never started). Tell
      // the printer too: it counts every enable against
      // MaximumVideoStreamAllowed until it is told otherwise, so skipping
      // onIdle here leaks a slot per failure until the camera is refused.
      const drop = () => {
        if (this.upstream !== handle) return;
        this.upstream = undefined;
        for (const v of this.viewers) v.end();
        this.viewers.clear();
        void this.onIdle?.();
      };
      handle.stream.on('end', drop);
      handle.stream.on('error', drop);
    })();

    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  /**
   * Write a chunk to one viewer, starting a new viewer at the next part.
   *
   * Chunks fall wherever the upstream happens to flush, so a viewer joining a
   * stream that is already running would otherwise start part-way through a
   * JPEG with no boundary line first. Browsers shrug that off; ffmpeg's
   * multipart probe gives up with "Invalid data found", which left go2rtc's
   * feed for the TV silently video-less (CTHU-23). Until a viewer has seen a
   * boundary it gets nothing, and then everything from that boundary on.
   */
  private deliver(viewer: PassThrough, chunk: Buffer): void {
    if (this.aligned.has(viewer)) {
      viewer.write(chunk);
      return;
    }
    // Keep the tail of the last chunk: a boundary can straddle two chunks.
    const tail = this.tails.get(viewer);
    const data = tail ? Buffer.concat([tail, chunk]) : chunk;
    const at = data.indexOf(PART_START);
    if (at === -1) {
      this.tails.set(viewer, data.subarray(Math.max(0, data.length - (PART_START.length - 1))));
      return;
    }
    this.tails.delete(viewer);
    this.aligned.add(viewer);
    viewer.write(data.subarray(at));
  }

  private async closeUpstream(): Promise<void> {
    const handle = this.upstream;
    this.upstream = undefined;
    if (handle) {
      // abort() first: destroying the stream alone leaves the TCP connection
      // established and the printer's single slot occupied.
      handle.abort();
      handle.stream.destroy();
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
