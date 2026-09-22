import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';

export interface BuildAppOptions {
  config: Config;
  logger?: boolean;
}

/**
 * Build the Fastify instance. Separated from listening so tests can drive it
 * with `inject()` and never bind a port.
 */
export function buildApp({ config, logger = false }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger });

  // Scraped by the Datadog agent on Leia, which autodiscovers containers.
  app.get('/health', async () => ({
    status: 'ok',
    printer: {
      pinnedIp: config.printerIp ?? null,
      discoveryEnabled: config.discoveryEnabled,
    },
  }));

  return app;
}
