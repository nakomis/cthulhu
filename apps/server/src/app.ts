import { randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { type CameraProxy, parseRange } from '@cthulhu/camera';
import {
  BatchDeleteError,
  MachineStatus,
  StartPrintError,
  UploadError,
  UploadRejectedError,
  uploadFile,
} from '@cthulhu/sdcp';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { listPrintableFiles } from './file-list.js';
import type { FileMetaCache } from './file-meta.js';
import type { HistoryStore } from './history.js';
import { buildMagicFile, listMagicFiles, MagicFileError } from './magic-files.js';
import type { PrintView } from './print-view.js';
import type { PrinterService } from './printer.js';
import type { PrinterStore } from './store.js';
import type { TimelapseArchiver } from './timelapse-archive.js';
import { registerWs } from './ws.js';

export interface BuildAppOptions {
  /** Directory of the built SPA, served at the root. */
  webRoot?: string;
  config: Config;
  store: PrinterStore;
  printer?: PrinterService;
  history?: HistoryStore;
  camera?: CameraProxy;
  /** Previews and details of print files, read from the printer. */
  fileMeta?: FileMetaCache;
  /** The current print's thumbnail and layer images. */
  printView?: PrintView;
  /** The camera service, which records and keeps the time-lapses. */
  timelapseBase?: string;
  /** Archived time-lapses on the share, once TIMELAPSE_ARCHIVE_DIR is set. */
  timelapseArchiver?: TimelapseArchiver;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const {
    config,
    store,
    printer,
    history,
    camera,
    fileMeta,
    printView,
    timelapseBase,
    timelapseArchiver,
    webRoot,
    logger = false,
  } = options;
  const printerAddress = () => store.snapshot().address ?? config.printerIp;
  const app = Fastify({ logger });

  // Registered before the routes that use it, and before the static handler,
  // so /api/ws is claimed by the websocket plugin rather than the SPA
  // catch-all.
  app.register(fastifyWebsocket);
  app.register(async (instance) => {
    registerWs(instance, { store });
  });

  // Scraped by the Datadog agent on Leia, which autodiscovers containers.
  app.get('/health', async () => ({
    status: 'ok',
    printer: {
      pinnedIp: config.printerIp ?? null,
      discoveryEnabled: config.discoveryEnabled,
      connected: store.snapshot().connected,
    },
  }));

  // Open to any origin so NakTV can read it: a webOS app loads from file://,
  // a null origin, and has no way past Leia's mTLS. Read-only, and nothing in
  // the snapshot is secret.
  app.get('/api/status', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    return store.snapshot();
  });

  app.get('/api/history', async (request) => {
    if (!history) return { prints: [] };
    const query = request.query as { limit?: string };
    const limit = Math.min(500, Math.max(1, Number(query.limit ?? 50) || 50));
    return { prints: await history.list(limit) };
  });

  app.get('/api/files', async (_request, reply) => {
    const client = printer?.client;
    if (!client) return reply.code(503).send({ error: 'Not connected to the printer' });
    try {
      return { files: await listPrintableFiles(client) };
    } catch (err) {
      return reply.code(502).send({ error: String(err) });
    }
  });

  const requireClient = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const client = printer?.client;
    if (!client) {
      reply.code(503).send({ error: 'Not connected to the printer' });
      return undefined;
    }
    return client;
  };

  app.post('/api/control/pause', async (_request, reply) => {
    const client = requireClient(reply);
    if (!client) return;
    await client.pause();
    return { ok: true };
  });

  app.post('/api/control/resume', async (_request, reply) => {
    const client = requireClient(reply);
    if (!client) return;
    await client.resume();
    return { ok: true };
  });

  /**
   * Stop abandons a print that may have been running for hours, so it requires
   * an explicit confirmation flag. A bare POST is rejected - a mis-click or a
   * stray curl should not bin the job.
   */
  app.post('/api/control/stop', async (request, reply) => {
    const body = (request.body ?? {}) as { confirm?: unknown };
    if (body.confirm !== true) {
      return reply.code(400).send({
        error: 'Stopping abandons the print. Send {"confirm": true} to proceed.',
      });
    }
    const client = requireClient(reply);
    if (!client) return;
    await client.stop();
    await history?.finishPrint(store.snapshot().print.taskId, 'stopped');
    return { ok: true };
  });

  /**
   * Delete files from the printer's storage.
   *
   * Takes a list rather than a path parameter because the printer's own command
   * is a batch one (Cmd 259 carries FileList and FolderList), and because
   * deleting six files one request at a time would mean six round trips over a
   * link where a round trip is not cheap.
   *
   * Like /api/control/stop, this requires an explicit confirm: deletion is
   * irreversible and the printer has no recycle bin.
   */
  app.post('/api/files/delete', async (request, reply) => {
    const body = (request.body ?? {}) as { files?: unknown; confirm?: unknown };
    if (body.confirm !== true) {
      return reply.code(400).send({
        error: 'Deleting is irreversible. Send {"confirm": true} to proceed.',
      });
    }
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return reply.code(400).send({ error: 'files must be a non-empty array of paths' });
    }
    const files = body.files.map(String);
    // Absolute and storage-qualified, as the printer expects and as
    // /api/files reports. A bare name would delete nothing and still ack.
    const bad = files.filter((path) => !/^\/(local|usb)\//.test(path));
    if (bad.length > 0) {
      return reply.code(400).send({
        error: `Paths must be absolute and storage-qualified, e.g. /local/part.goo — got: ${bad.join(', ')}`,
      });
    }

    const client = requireClient(reply);
    if (!client) return;

    // Refusing to delete the file being printed. The printer might well allow
    // it; losing a running job to a mis-click is not worth finding out.
    //
    // print.filename alone is NOT enough to decide that: it comes straight from
    // the printer's status, which keeps showing the LAST print's name at
    // Complete, Stopped and Idle. Guarding on the name by itself would make a
    // file undeletable for ever once it had been printed. The machine has to
    // actually be printing.
    const snapshot = store.snapshot();
    const busy = snapshot.machineStatus.includes(MachineStatus.Printing);
    const current = busy ? snapshot.print.filename : undefined;
    if (current) {
      const clash = files.filter((path) => path === current || path.endsWith(`/${current}`));
      if (clash.length > 0) {
        return reply
          .code(409)
          .send({ error: `${current} is printing right now; stop the print first` });
      }
    }

    try {
      await client.deleteFiles(files);
    } catch (err) {
      if (err instanceof BatchDeleteError) {
        return reply.code(502).send({ error: err.message, ack: err.ack });
      }
      throw err;
    }

    // The printer pushes no new listing, so re-read it here and hand it back:
    // it saves the caller a second request, and it is the only proof the
    // delete actually took effect rather than merely being acked.
    try {
      return { ok: true, deleted: files, files: await listPrintableFiles(client) };
    } catch {
      return { ok: true, deleted: files };
    }
  });

  app.post('/api/print', async (request, reply) => {
    const body = (request.body ?? {}) as { filename?: unknown; startLayer?: unknown };
    if (typeof body.filename !== 'string' || body.filename.length === 0) {
      return reply.code(400).send({ error: 'filename is required' });
    }
    const client = requireClient(reply);
    if (!client) return;

    const startLayer = typeof body.startLayer === 'number' ? body.startLayer : 0;
    try {
      await client.startPrint(body.filename, startLayer);
    } catch (err) {
      // Surface the printer's actual reason rather than a generic 500 - "MD5
      // failed" and "unknown format" need very different responses from a user.
      if (err instanceof StartPrintError) {
        return reply.code(409).send({ error: err.message, ack: err.ack });
      }
      throw err;
    }
    // History is recorded by the store's printStarted event, not here: at
    // this point the printer has only acked, and the taskId does not exist
    // until the next status push.
    return { ok: true };
  });

  /**
   * Upload a sliced file to the printer.
   *
   * Body is the raw file; the name comes from the x-filename header. Fastify
   * is told to hand us the body untouched rather than trying to parse it.
   */
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  // ---- Print files: previews and details, from the files themselves -------
  app.get<{ Querystring: { path?: string } }>('/api/files/meta', async (request, reply) => {
    const address = printerAddress();
    const path = request.query.path;
    if (!fileMeta || !address || !path) return reply.code(404).send({ error: 'Unavailable' });
    const meta = await fileMeta.meta(address, path).catch(() => undefined);
    if (!meta) return reply.code(404).send({ error: 'No details for that file' });
    return meta;
  });

  app.get<{ Querystring: { path?: string } }>('/api/files/preview', async (request, reply) => {
    const address = printerAddress();
    const path = request.query.path;
    if (!fileMeta || !address || !path) return reply.code(404).send({ error: 'Unavailable' });
    const png = await fileMeta.preview(address, path).catch(() => undefined);
    if (!png) return reply.code(404).send({ error: 'No preview for that file' });
    return reply.type('image/png').header('Cache-Control', 'max-age=300').send(png);
  });

  // ---- The current print: the printer's thumbnail, and the layer --------
  const currentTask = () => {
    const { taskId, currentLayer } = store.snapshot().print;
    const address = printerAddress();
    return taskId && address ? { taskId, address, currentLayer: currentLayer ?? 0 } : undefined;
  };

  app.get('/api/print/thumbnail', async (_request, reply) => {
    const task = currentTask();
    if (!printView || !task) return reply.code(404).send({ error: 'Nothing printing' });
    const png = await printView.thumbnail(task.address, task.taskId).catch(() => undefined);
    if (!png) return reply.code(404).send({ error: 'No thumbnail for this print' });
    return reply.type('image/png').header('Cache-Control', 'max-age=3600').send(png);
  });

  // PNG when ready; 202 with progress while the print file is still coming
  // from the printer, so the page can say so rather than show nothing.
  //
  // `scale` (1-20, default 10) is how far to shrink the 8520 x 4320 layer:
  // the Status box wants 852 x 432, the lightbox more, and scale=1 is every
  // pixel the LCD shows.
  app.get<{ Querystring: { layer?: string; scale?: string } }>(
    '/api/print/layer',
    async (request, reply) => {
      const scale = parseScale(request.query.scale);
      if (scale === 'invalid') {
        return reply.code(400).send({ error: 'scale must be a whole number from 1 to 20' });
      }
      const task = currentTask();
      if (!printView || !task) return reply.code(404).send({ error: 'Nothing printing' });
      const asked = Number(request.query.layer);
      const index = Number.isInteger(asked) && asked >= 0 ? asked : task.currentLayer;
      const result = await printView.layer(task.address, task.taskId, index, scale);
      if (result.state === 'ready') {
        return reply
          .type('image/png')
          .header('X-Layer', String(result.layer))
          .header('Cache-Control', 'no-cache')
          .send(result.png);
      }
      if (result.state === 'downloading') return reply.code(202).send(result);
      return reply.code(502).send({ error: result.error });
    },
  );

  // ---- Time-lapses: made by the camera service, archived to the share ---
  //
  // Without TIMELAPSE_ARCHIVE_DIR, everything comes live from the camera
  // service - today's behaviour. With it, a `ready` time-lapse eventually
  // moves to the archive (TimelapseArchiver, on a 60 s tick and promptly
  // after a print finishes) and then appears from there instead; anything
  // still recording, assembling, failed, or ready but not yet archived still
  // comes from the camera service.
  app.get('/api/timelapses', async (_request, reply) => {
    // Archived entries are always `ready` - they would not be archived
    // otherwise - and the web app keys its download/play controls off that.
    const archived = (timelapseArchiver?.list() ?? []).map((t) => ({
      ...t,
      state: 'ready' as const,
    }));

    if (!timelapseBase) return archived;
    const res = await fetch(`${timelapseBase}/timelapse`).catch(() => undefined);
    if (!res?.ok) {
      // The archive still stands even when the camera service is down -
      // that is rather the point of archiving it.
      if (archived.length > 0) return archived;
      return reply.code(502).send({ error: 'The camera service did not answer' });
    }
    const remote = (await res.json()) as { id: string; state?: string; startedAt: string }[];
    // Named after the file printed, from cthulhu's own history.
    const names = new Map(
      (history ? await history.list(500) : []).map((p) => [p.taskId, p.filename]),
    );

    const archivedIds = new Set(archived.map((t) => t.id));
    const live = remote
      .filter((t) => !archivedIds.has(t.id))
      .map((t) => ({ ...t, filename: names.get(t.id) ?? null }));

    return [...archived, ...live].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  });

  app.get<{ Params: { id: string } }>('/api/timelapses/:id.mp4', async (request, reply) => {
    const id = request.params.id;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) {
      return reply.code(404).send({ error: 'No such time-lapse' });
    }

    const archivedPath = timelapseArchiver?.videoPath(id);
    if (archivedPath) {
      const size = statSync(archivedPath).size;
      const result = parseRange(request.headers.range, size);
      if (result === 'invalid') {
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      }
      const { start, end, partial } = result;
      reply
        .code(partial ? 206 : 200)
        .header('Content-Type', 'video/mp4')
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', String(end - start + 1));
      if (partial) reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      return reply.send(createReadStream(archivedPath, { start, end }));
    }

    if (!timelapseBase) return reply.code(404).send({ error: 'No such time-lapse' });
    // Range passed through, so the player can seek.
    const range = request.headers.range;
    const res = await fetch(`${timelapseBase}/timelapse/${id}.mp4`, {
      headers: range ? { Range: range } : {},
    }).catch(() => undefined);
    if (!res?.body || (!res.ok && res.status !== 206)) {
      return reply.code(res?.status === 404 ? 404 : 502).send({ error: 'No video' });
    }
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = res.headers.get(h);
      if (v) reply.header(h, v);
    }
    const { Readable } = await import('node:stream');
    return reply
      .code(res.status)
      .send(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]));
  });

  /**
   * The upload currently in progress, if any.
   *
   * Tracked so it can be cancelled from another request: an upload of a few
   * hundred megabytes holds its connection for minutes, and without this the
   * only way to stop one was to restart cthulhu.
   *
   * Exactly one at a time. The printer reassembles a transfer by offset under a
   * single Uuid, so two concurrent uploads would interleave and corrupt each
   * other — which is worth a 409 rather than a race.
   */
  interface InflightUpload {
    uuid: string;
    filename: string;
    controller: AbortController;
    startedAt: number;
    /** Bytes the printer has accepted. */
    sent: number;
    total: number;
    /** When the FIRST packet was accepted, and how big it was. */
    firstPacketAt?: number;
    firstPacketBytes?: number;
  }
  let inflight: InflightUpload | undefined;

  app.post('/api/upload', { bodyLimit: config.maxUploadBytes }, async (request, reply) => {
    const filename = request.headers['x-filename'];
    if (typeof filename !== 'string' || filename.length === 0) {
      return reply.code(400).send({ error: 'x-filename header is required' });
    }
    // The printer only understands its own formats; catching it here gives a
    // better message than ack 6 (unknown format) after a long upload.
    if (!/\.(goo|ctb)$/i.test(filename)) {
      return reply.code(400).send({ error: 'Only .goo and .ctb files are supported' });
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'Empty request body' });
    }

    const address = store.snapshot().address ?? config.printerIp;
    if (!address) return reply.code(503).send({ error: 'No printer address' });

    // Needed to hear the verdict: the printer accepts every packet over HTTP
    // and reports a rejected file only on the WebSocket.
    const client = printer?.client;
    if (!client) return reply.code(503).send({ error: 'Not connected to the printer' });

    if (inflight) {
      return reply.code(409).send({
        error: `Already uploading ${inflight.filename}. Cancel it first, or wait.`,
      });
    }

    // Generated HERE rather than left to uploadFile, because cancelling needs
    // it: Cmd 255 identifies a transfer by Uuid, so it has to be known before
    // the upload starts, not returned when it ends.
    const uuid = randomUUID().replace(/-/g, '');
    const controller = new AbortController();
    const tracked: InflightUpload = {
      uuid,
      filename,
      controller,
      startedAt: Date.now(),
      sent: 0,
      total: body.length,
    };
    inflight = tracked;

    try {
      const result = await uploadFile({
        address,
        filename,
        data: body,
        uuid,
        signal: controller.signal,
        // Progress is counted here rather than guessed from elapsed time: the
        // first packet costs far more than the rest, because it pays for the
        // connection, so a linear extrapolation from the start is badly wrong.
        onProgress: (sent) => {
          if (tracked.firstPacketAt === undefined) {
            tracked.firstPacketAt = Date.now();
            tracked.firstPacketBytes = sent;
          }
          tracked.sent = sent;
        },
        ...(config.uploadPort ? { port: config.uploadPort } : {}),
      });
      const path = await client.confirmUploaded(filename);
      return { ...result, path };
    } catch (err) {
      // A cancelled upload is not a failure to report as one: the caller asked
      // for it and already has its 200 from /api/upload/cancel.
      if (controller.signal.aborted) {
        return reply.code(499).send({ error: `Upload of ${filename} cancelled` });
      }
      if (err instanceof UploadError || err instanceof UploadRejectedError) {
        return reply.code(502).send({ error: err.message });
      }
      throw err;
    } finally {
      inflight = undefined;
    }
  });

  /**
   * How far the upload in progress has got.
   *
   * Polled by the UI rather than measured in the browser. A browser can only
   * see its own request body reaching cthulhu, which is local and near-instant:
   * XMLHttpRequest's upload progress would read 100% within a second and then
   * sit there for minutes. The slow leg is cthulhu to the printer, and only the
   * server can see it.
   *
   * 204 rather than 404 when nothing is uploading: the UI polls this on a timer
   * and an absent upload is the normal case, not an error worth logging.
   */
  app.get('/api/upload/progress', async (_request, reply) => {
    const current = inflight;
    if (!current) return reply.code(204).send();

    const now = Date.now();
    const elapsedMs = now - current.startedAt;

    // Measured from what has actually been sent, NOT from a per-megabyte
    // constant. The constant in the UI came from a different, faster client and
    // was optimistic by an order of magnitude, and the real rate varies with the
    // link, which on this printer is wireless and sometimes degraded.
    //
    // The rate is taken from the SECOND packet onwards. The first one carries
    // the entire cost of opening the connection - about seven seconds on this
    // printer, against ~0.3s for a packet on an established one - so a rate
    // averaged over it over-estimates the remaining time by an order of
    // magnitude on a long file. No estimate at all until two have landed:
    // a wrong ETA is worse than none.
    const sinceFirst = current.sent - (current.firstPacketBytes ?? 0);
    const msSinceFirst = current.firstPacketAt ? now - current.firstPacketAt : 0;
    const remainingMs =
      sinceFirst > 0 && msSinceFirst > 0
        ? Math.round(((current.total - current.sent) * msSinceFirst) / sinceFirst)
        : undefined;

    return {
      filename: current.filename,
      sent: current.sent,
      total: current.total,
      percent: current.total > 0 ? Math.round((current.sent / current.total) * 100) : 0,
      elapsedMs,
      ...(remainingMs !== undefined ? { remainingMs } : {}),
    };
  });

  /**
   * Cancel the upload in progress.
   *
   * Two things happen, in this order, and they are independent:
   *
   *  1. We stop sending. This is the part that always works and the part that
   *     actually frees the link.
   *  2. The printer is asked to discard the partial file (Cmd 255). This is
   *     best-effort: the command's argument names are taken from the spec and
   *     have never been seen on the wire here, so a refusal is reported in the
   *     response rather than failing the cancel.
   */
  app.post('/api/upload/cancel', async (_request, reply) => {
    const current = inflight;
    if (!current) return reply.code(409).send({ error: 'No upload in progress' });

    current.controller.abort(new Error('Cancelled by request'));

    let printerNotified = false;
    let printerError: string | undefined;
    const client = printer?.client;
    if (client) {
      try {
        await client.terminateFileTransfer(current.uuid, current.filename);
        printerNotified = true;
      } catch (err) {
        printerError = err instanceof Error ? err.message : String(err);
      }
    } else {
      printerError = 'Not connected to the printer';
    }

    return {
      ok: true,
      cancelled: current.filename,
      /** False means the printer may still be holding a partial file. */
      printerNotified,
      ...(printerError ? { printerError } : {}),
    };
  });

  /**
   * Magic Files - small config gcode files that fix known printer quirks.
   * See magic-files.ts and the README's "What the real printer taught us".
   */
  app.get('/api/magic', async () => ({ files: listMagicFiles(config) }));

  /**
   * Send a Magic File to the printer, over the same upload path as a normal
   * print file. Unlike /api/upload this does NOT call confirmUploaded(): the
   * file lands in /local but the Cmd 258 listing hides it, so waiting for it
   * to appear there would just time out. These can only be run from the
   * printer's own touchscreen Print menu, so a successful upload is the end
   * of the server's part of the job.
   */
  app.post<{ Params: { id: string } }>('/api/magic/:id/send', async (request, reply) => {
    let file: { filename: string; data: string };
    try {
      file = buildMagicFile(request.params.id, config);
    } catch (err) {
      if (err instanceof MagicFileError) {
        return reply.code(err.code === 'not-found' ? 404 : 409).send({ error: err.message });
      }
      throw err;
    }

    const address = store.snapshot().address ?? config.printerIp;
    if (!address) return reply.code(503).send({ error: 'No printer address' });

    const client = printer?.client;
    if (!client) return reply.code(503).send({ error: 'Not connected to the printer' });

    // A Magic File is a few hundred bytes and finishes before it could
    // meaningfully collide with a real upload, but the printer reassembles
    // transfers by offset under a single Uuid regardless of size - so it
    // shares the same one-at-a-time guard as /api/upload.
    if (inflight) {
      return reply.code(409).send({
        error: `Already uploading ${inflight.filename}. Cancel it first, or wait.`,
      });
    }

    try {
      const result = await uploadFile({
        address,
        filename: file.filename,
        data: Buffer.from(file.data, 'utf8'),
        ...(config.uploadPort ? { port: config.uploadPort } : {}),
      });
      return { ok: true, filename: result.filename, size: result.size };
    } catch (err) {
      if (err instanceof UploadError || err instanceof UploadRejectedError) {
        return reply.code(502).send({ error: err.message });
      }
      throw err;
    }
  });

  if (camera) {
    app.get('/api/camera/stream', async (_request, reply) => {
      let viewer: Awaited<ReturnType<typeof camera.addViewer>>;
      try {
        viewer = await camera.addViewer();
      } catch (err) {
        // Without this the browser hangs on a never-answered request when the
        // upstream URL is wrong or the printer's camera is off.
        return reply.code(502).send({ error: `Camera unavailable: ${String(err)}` });
      }
      reply.raw.on('close', () => viewer.end());
      return reply
        .header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        .header('Cache-Control', 'no-store')
        .send(viewer);
    });

    app.get('/api/camera/viewers', async () => ({
      viewers: camera.viewerCount,
      upstreamOpen: camera.upstreamOpen,
    }));
  }

  if (webRoot) {
    // Serving the SPA from the API origin keeps it to one nginx vhost behind
    // Leia, and means no CORS and no second certificate.
    app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      // Client-side routing: anything without a file extension is the SPA.
      if (
        request.method === 'GET' &&
        !request.url.includes('.') &&
        !request.url.startsWith('/api')
      ) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}

/**
 * The layer route's `scale`: undefined when not given (the server's default),
 * 'invalid' for anything but a plain whole number from 1 to 20.
 */
export function parseScale(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  if (!/^\d{1,2}$/.test(raw)) return 'invalid';
  const scale = Number(raw);
  return scale >= 1 && scale <= 20 ? scale : 'invalid';
}
