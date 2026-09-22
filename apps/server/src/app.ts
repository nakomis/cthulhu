import { StartPrintError } from '@cthulhu/sdcp';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CameraProxy } from './camera.js';
import type { Config } from './config.js';
import type { History } from './history.js';
import type { PrinterService } from './printer.js';
import type { PrinterStore } from './store.js';

export interface BuildAppOptions {
  config: Config;
  store: PrinterStore;
  printer?: PrinterService;
  history?: History;
  camera?: CameraProxy;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config, store, printer, history, camera, logger = false } = options;
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
    history?.startPrint(store.snapshot().print.taskId, body.filename);
    return { ok: true };
  });

  if (camera) {
    app.get('/api/camera/stream', async (_request, reply) => {
      const viewer = await camera.addViewer();
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

  return app;
}
