import type { FastifyInstance } from 'fastify';
import type { PrinterStore, PrinterView } from './store.js';

/**
 * Push printer state to browsers over a WebSocket.
 *
 * The dashboard polled every 2 seconds before this. Polling works, but it is
 * the wrong shape here: the printer already pushes unsolicited status frames
 * to us, so we were converting a push into a poll and adding up to 2s of
 * latency for nothing. It also means N browsers cost N requests per interval
 * whether or not anything changed.
 *
 * Deliberately one-way. Control stays on the REST endpoints, where a stop can
 * carry its confirmation flag and a failure can be a status code rather than
 * a message someone has to correlate.
 */
export interface RegisterWsOptions {
  store: PrinterStore;
  /** Heartbeat period. Something has to notice a silently-dead peer. */
  pingMs?: number;
}

export function registerWs(app: FastifyInstance, options: RegisterWsOptions): void {
  const { store, pingMs = 30_000 } = options;

  app.get('/api/ws', { websocket: true }, (socket) => {
    // Send the current state immediately: a client that connects between
    // changes would otherwise show nothing until the printer next moved.
    const send = (view: PrinterView) => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(view));
      } catch {
        // A peer that has gone away is not an error worth propagating.
      }
    };

    send(store.snapshot());
    store.on('update', send);

    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, pingMs);
    // Do not hold the event loop open for a heartbeat.
    (ping as unknown as { unref?: () => void }).unref?.();

    socket.on('close', () => {
      clearInterval(ping);
      // Removing the listener matters: PrinterStore is long-lived and a leak
      // here accumulates one listener per browser refresh, eventually
      // tripping MaxListenersExceededWarning and pushing to dead sockets.
      store.off('update', send);
    });

    socket.on('error', () => {
      clearInterval(ping);
      store.off('update', send);
    });
  });
}
