import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

describe('GET /health', () => {
  it('reports ok and how the printer is reached', async () => {
    const app = buildApp({ config: loadConfig({ PRINTER_IP: '192.168.1.2' }) });
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      printer: { pinnedIp: '192.168.1.2', discoveryEnabled: true },
    });
    await app.close();
  });

  it('reports a null pinned ip when relying on discovery', async () => {
    const app = buildApp({ config: loadConfig({}) });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json().printer.pinnedIp).toBeNull();
    await app.close();
  });
});
