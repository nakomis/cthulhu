import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type BuildAppOptions, buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PrinterStore } from './store.js';
import { TimelapseArchiver } from './timelapse-archive.js';

const make = (env: NodeJS.ProcessEnv, extra: Partial<BuildAppOptions> = {}) =>
  buildApp({ config: loadConfig(env), store: new PrinterStore(), ...extra });

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

/** A stand-in for the camera service's /timelapse routes. */
function fakeCameraService(
  list: { id: string; state: string; startedAt: string }[],
): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/timelapse') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list));
      return;
    }
    if (req.url?.endsWith('.mp4')) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' }).end('LIVE-MP4');
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('GET /api/timelapses', () => {
  let dir: string;
  let closeCamera: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeCamera?.();
    closeCamera = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('merges archived time-lapses with whatever the camera service still holds, newest first', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-routes-'));
    const archiver = new TimelapseArchiver({ baseUrl: 'unused', dir, fetchImpl: fetch });
    writeFileSync(join(dir, 'old.mp4'), 'ARCHIVED');
    writeFileSync(
      join(dir, 'old.json'),
      JSON.stringify({
        id: 'old',
        frames: 10,
        startedAt: '2026-09-24T08:00:00.000Z',
        bytes: 8,
        filename: null,
      }),
    );

    const camera = await fakeCameraService([
      { id: 'new', state: 'ready', startedAt: '2026-09-24T10:00:00.000Z' },
      // Already archived: must NOT appear twice.
      { id: 'old', state: 'ready', startedAt: '2026-09-24T08:00:00.000Z' },
    ]);
    closeCamera = camera.close;

    const app = make(
      { PRINTER_IP: '10.0.0.1' },
      { timelapseBase: camera.base, timelapseArchiver: archiver },
    );
    const res = await app.inject({ method: 'GET', url: '/api/timelapses' });
    const list = res.json();
    expect(list.map((t: { id: string }) => t.id)).toEqual(['new', 'old']);
    // The archived entry must report `ready` - the web app's download link
    // and video player are both keyed off that.
    expect(list.find((t: { id: string }) => t.id === 'old')?.state).toBe('ready');
    await app.close();
  });

  it('is empty with neither a camera service nor an archive configured', async () => {
    const app = make({ PRINTER_IP: '10.0.0.1' });
    const res = await app.inject({ method: 'GET', url: '/api/timelapses' });
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('still serves the archive when the camera service is unreachable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-routes-'));
    const archiver = new TimelapseArchiver({ baseUrl: 'unused', dir, fetchImpl: fetch });
    writeFileSync(join(dir, 'old.mp4'), 'ARCHIVED');
    writeFileSync(
      join(dir, 'old.json'),
      JSON.stringify({
        id: 'old',
        frames: 10,
        startedAt: '2026-09-24T08:00:00.000Z',
        bytes: 8,
        filename: null,
      }),
    );

    // A camera base that answers nothing at all - the point being that the
    // archive is not the thing that fails.
    const app = make(
      { PRINTER_IP: '10.0.0.1' },
      { timelapseBase: 'http://127.0.0.1:1', timelapseArchiver: archiver },
    );
    const res = await app.inject({ method: 'GET', url: '/api/timelapses' });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((t: { id: string }) => t.id)).toEqual(['old']);
    await app.close();
  });
});

describe('GET /api/timelapses/:id.mp4', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('serves an archived file whole when there is no Range header', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-video-'));
    const archiver = new TimelapseArchiver({ baseUrl: 'unused', dir, fetchImpl: fetch });
    writeFileSync(join(dir, 'a1.mp4'), '0123456789');
    writeFileSync(
      join(dir, 'a1.json'),
      JSON.stringify({ id: 'a1', frames: 1, startedAt: 'x', bytes: 10, filename: null }),
    );

    const app = make({ PRINTER_IP: '10.0.0.1' }, { timelapseArchiver: archiver });
    const res = await app.inject({ method: 'GET', url: '/api/timelapses/a1.mp4' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.body).toBe('0123456789');
    await app.close();
  });

  it('answers 206 with Content-Range for a partial request', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-video-'));
    const archiver = new TimelapseArchiver({ baseUrl: 'unused', dir, fetchImpl: fetch });
    writeFileSync(join(dir, 'a1.mp4'), '0123456789');
    writeFileSync(
      join(dir, 'a1.json'),
      JSON.stringify({ id: 'a1', frames: 1, startedAt: 'x', bytes: 10, filename: null }),
    );

    const app = make({ PRINTER_IP: '10.0.0.1' }, { timelapseArchiver: archiver });
    const res = await app.inject({
      method: 'GET',
      url: '/api/timelapses/a1.mp4',
      headers: { range: 'bytes=2-4' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-4/10');
    expect(res.body).toBe('234');
    await app.close();
  });

  it('answers 416 for a range starting past the end of the file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-video-'));
    const archiver = new TimelapseArchiver({ baseUrl: 'unused', dir, fetchImpl: fetch });
    writeFileSync(join(dir, 'a1.mp4'), '0123456789');
    writeFileSync(
      join(dir, 'a1.json'),
      JSON.stringify({ id: 'a1', frames: 1, startedAt: 'x', bytes: 10, filename: null }),
    );

    const app = make({ PRINTER_IP: '10.0.0.1' }, { timelapseArchiver: archiver });
    const res = await app.inject({
      method: 'GET',
      url: '/api/timelapses/a1.mp4',
      headers: { range: 'bytes=100-200' },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */10');
    await app.close();
  });

  it('falls back to proxying the camera service when not archived', async () => {
    const camera = await fakeCameraService([]);
    const app = make({ PRINTER_IP: '10.0.0.1' }, { timelapseBase: camera.base });
    const res = await app.inject({ method: 'GET', url: '/api/timelapses/live1.mp4' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('LIVE-MP4');
    await app.close();
    await camera.close();
  });

  it('404s an id that is neither archived nor available live', async () => {
    const app = make({ PRINTER_IP: '10.0.0.1' });
    const res = await app.inject({ method: 'GET', url: '/api/timelapses/nope.mp4' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a malformed id before touching the filesystem or the camera service', async () => {
    const app = make({ PRINTER_IP: '10.0.0.1' });
    const res = await app.inject({ method: 'GET', url: '/api/timelapses/../../etc.mp4' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
