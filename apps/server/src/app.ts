import { StartPrintError, UploadError, uploadFile } from '@cthulhu/sdcp';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CameraProxy } from './camera.js';
import type { Config } from './config.js';
import type { History } from './history.js';
import type { PrinterService } from './printer.js';
import type { PrinterStore } from './store.js';

export interface BuildAppOptions {
  /** Directory of the built SPA, served at the root. */
  webRoot?: string;
  config: Config;
  store: PrinterStore;
  printer?: PrinterService;
  history?: History;
  camera?: CameraProxy;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config, store, printer, history, camera, webRoot, logger = false } = options;
  const app = Fastify({ logger });

  // Scraped by the Datadog agent on Leia, which autodiscovers containers.
  app.get('/health', async () => ({
    status: 'ok',
    printer: {
      pinnedIp: config.printerIp ?? null,
      discoveryEnabled: config.discoveryEnabled,
      connected: store.snapshot().connected,
    },
  }));

  app.get('/api/status', async () => store.snapshot());

  app.get('/api/history', async (request) => {
    if (!history) return { prints: [] };
    const query = request.query as { limit?: string };
    const limit = Math.min(500, Math.max(1, Number(query.limit ?? 50) || 50));
    return { prints: history.list(limit) };
  });

  app.get('/api/files', async (_request, reply) => {
    const client = printer?.client;
    if (!client) return reply.code(503).send({ error: 'Not connected to the printer' });
    try {
      const result = await client.listFiles();
      return result;
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
    history?.finishPrint(store.snapshot().print.taskId, 'stopped');
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

  app.post('/api/upload', async (request, reply) => {
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

    try {
      const result = await uploadFile({
        address,
        filename,
        data: body,
        ...(config.uploadPort ? { port: config.uploadPort } : {}),
      });
      return result;
    } catch (err) {
      if (err instanceof UploadError) {
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
