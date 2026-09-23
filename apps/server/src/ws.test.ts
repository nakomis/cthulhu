import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PrinterStore } from './store.js';

let app: ReturnType<typeof buildApp>;
let store: PrinterStore;
let url: string;

beforeEach(async () => {
  store = new PrinterStore();
  app = buildApp({ config: loadConfig({ PRINTER_IP: '127.0.0.1' }), store });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  url = `ws://127.0.0.1:${port}/api/ws`;
});

afterEach(async () => {
  await app.close();
});

/**
 * Collect messages from the moment the socket is created.
 *
 * Attaching a listener only after 'open' loses the snapshot the server sends
 * immediately on connect - it has already been delivered and dropped, and the
 * test then waits for a message that will never come again. That race cost an
 * afternoon; buffer from construction instead.
 */
function connect(url: string) {
  const ws = new WebSocket(url);
  const queue: Record<string, unknown>[] = [];
  const waiters: ((v: Record<string, unknown>) => void)[] = [];

  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });

  const next = () =>
    new Promise<Record<string, unknown>>((resolve) => {
      const queued = queue.shift();
      if (queued) resolve(queued);
      else waiters.push(resolve);
    });

  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  return { ws, next, opened };
}

describe('GET /api/ws', () => {
  it('sends a snapshot immediately on connect', async () => {
    // A client connecting between changes would otherwise see nothing at all
    // until the printer next moved, which on an idle printer is for ever.
    const { ws, next, opened } = connect(url);
    await opened;
    const first = await next();
    expect(first).toHaveProperty('connected');
    expect(first).toHaveProperty('print');
    ws.close();
  });

  it('pushes on every store update', async () => {
    const { ws, next, opened } = connect(url);
    await opened;
    await next(); // the initial snapshot

    const pushed = next();
    store.setConnection(true, '172.29.0.50', 'mb-1');
    const view = await pushed;

    expect(view.connected).toBe(true);
    expect(view.address).toBe('172.29.0.50');
    ws.close();
  });

  it('serves several clients from the one store', async () => {
    const a = connect(url);
    const b = connect(url);
    await Promise.all([a.opened, b.opened]);
    await Promise.all([a.next(), b.next()]);

    const both = Promise.all([a.next(), b.next()]);
    store.setConnection(true, '172.29.0.51', 'mb-2');
    const [va, vb] = await both;

    expect(va.address).toBe('172.29.0.51');
    expect(vb.address).toBe('172.29.0.51');
    a.ws.close();
    b.ws.close();
  });

  it('removes its listener on close, so refreshes do not leak', async () => {
    // PrinterStore is long-lived. One leaked listener per browser refresh
    // eventually trips MaxListenersExceededWarning and pushes to dead sockets.
    const before = store.listenerCount('update');

    const { ws, next, opened } = connect(url);
    await opened;
    await next();
    expect(store.listenerCount('update')).toBe(before + 1);

    ws.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(store.listenerCount('update')).toBe(before);
  });
});
