import { createReadStream, statSync } from 'node:fs';
import { type CameraProxy, parseRange } from '@cthulhu/camera';
import { StartPrintError, UploadError, UploadRejectedError, uploadFile } from '@cthulhu/sdcp';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { listPrintableFiles } from './file-list.js';
import type { FileMetaCache } from './file-meta.js';
import type { HistoryStore } from './history.js';
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
  app.get<{ Querystring: { layer?: string } }>('/api/print/layer', async (request, reply) => {
    const task = currentTask();
    if (!printView || !task) return reply.code(404).send({ error: 'Nothing printing' });
    const asked = Number(request.query.layer);
    const index = Number.isInteger(asked) && asked >= 0 ? asked : task.currentLayer;
    const result = await printView.layer(task.address, task.taskId, index);
    if (result.state === 'ready') {
      return reply
        .type('image/png')
        .header('X-Layer', String(result.layer))
        .header('Cache-Control', 'no-cache')
        .send(result.png);
    }
    if (result.state === 'downloading') return reply.code(202).send(result);
    return reply.code(502).send({ error: result.error });
  });

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

    try {
      const result = await uploadFile({
        address,
        filename,
        data: body,
        ...(config.uploadPort ? { port: config.uploadPort } : {}),
      });
      const path = await client.confirmUploaded(filename);
      return { ...result, path };
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
