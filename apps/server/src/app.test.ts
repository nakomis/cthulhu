import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PrinterStore } from './store.js';

const make = (env: NodeJS.ProcessEnv) =>
  buildApp({ config: loadConfig(env), store: new PrinterStore() });

describe('GET /health', () => {
  it('reports ok and how the printer is reached', async () => {
    const app = make({ PRINTER_IP: '192.168.1.2' });
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      printer: { pinnedIp: '192.168.1.2', discoveryEnabled: true, connected: false },
    });
    await app.close();
  });

  it('reports a null pinned ip when relying on discovery', async () => {
    const app = make({});
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json().printer.pinnedIp).toBeNull();
    await app.close();
  });

  it('answers even with no printer attached, so the container looks healthy', async () => {
    // /health must not depend on the printer: a printer that is switched off
    // is normal, and must not make Docker restart the container in a loop.
    const app = make({ PRINTER_IP: '10.0.0.1' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().printer.connected).toBe(false);
    await app.close();
  });
});

describe('control endpoints without a printer', () => {
  it.each(['/api/control/pause', '/api/control/resume'])('%s returns 503', async (url) => {
    const app = make({ PRINTER_IP: '10.0.0.1' });
    const res = await app.inject({ method: 'POST', url });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('checks the stop confirmation BEFORE the connection, so the guard cannot be bypassed', async () => {
    const app = make({ PRINTER_IP: '10.0.0.1' });
    const res = await app.inject({ method: 'POST', url: '/api/control/stop', payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
