import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteHistory } from './history.js';
import { TimelapseArchiver } from './timelapse-archive.js';

let dir: string;
let history: SqliteHistory;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tl-archive-'));
  history = new SqliteHistory(join(dir, 'history.sqlite'));
});
afterEach(async () => {
  await history.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fetch stub standing in for the camera service's /timelapse routes. */
function fakeCameraService(options: {
  list: {
    id: string;
    state: 'recording' | 'assembling' | 'ready' | 'failed';
    frames: number;
    startedAt: string;
    finishedAt?: string;
    bytes?: number;
  }[];
  video?: Record<string, string>;
  onDelete?: (id: string) => void;
  downloadFails?: Set<string>;
}) {
  const deleted: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.endsWith('/timelapse') && method === 'GET') {
      return new Response(JSON.stringify(options.list), { status: 200 });
    }
    const mp4 = /\/timelapse\/([^/]+)\.mp4$/.exec(u);
    if (mp4 && method === 'GET') {
      const id = mp4[1] as string;
      if (options.downloadFails?.has(id)) return new Response('', { status: 502 });
      return new Response(options.video?.[id] ?? 'MP4-BYTES', { status: 200 });
    }
    const del = /\/timelapse\/([^/.]+)$/.exec(u);
    if (del && method === 'DELETE') {
      const id = del[1] as string;
      deleted.push(id);
      options.onDelete?.(id);
      return new Response('{}', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, deleted };
}

describe('TimelapseArchiver', () => {
  it('archives a ready time-lapse: downloads it, writes metadata, then deletes the camera copy', async () => {
    await history.startPrint('t1', 'cthulhu.goo', 120, '2026-09-24T09:00:00.000Z');
    await history.finishPrint('t1', 'complete');
    const { fetchImpl, deleted } = fakeCameraService({
      list: [{ id: 't1', state: 'ready', frames: 120, startedAt: '2026-09-24T09:00:00.000Z' }],
    });
    const archiver = new TimelapseArchiver({ baseUrl: 'http://phi:9121', dir, history, fetchImpl });

    await archiver.tick();

    expect(existsSync(join(dir, 't1.mp4'))).toBe(true);
    expect(readFileSync(join(dir, 't1.mp4'), 'utf8')).toBe('MP4-BYTES');
    // The .part file used while downloading must not be left behind.
    expect(existsSync(join(dir, 't1.mp4.part'))).toBe(false);
    const meta = JSON.parse(readFileSync(join(dir, 't1.json'), 'utf8'));
    expect(meta).toMatchObject({ id: 't1', frames: 120, filename: 'cthulhu.goo' });
    expect(deleted).toEqual(['t1']);
    expect(archiver.isArchived('t1')).toBe(true);
  });

  it('never archives the same time-lapse twice', async () => {
    const { fetchImpl } = fakeCameraService({
      list: [{ id: 't1', state: 'ready', frames: 10, startedAt: '2026-09-24T09:00:00.000Z' }],
    });
    const archiver = new TimelapseArchiver({ baseUrl: 'http://phi:9121', dir, fetchImpl });
    await archiver.tick();
    await archiver.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(
      // First tick: list, download, delete. Second tick: list only - it sees
      // the same id but skips it because it is already archived.
      4,
    );
  });

  it('leaves recording, assembling and failed time-lapses alone', async () => {
    const { fetchImpl, deleted } = fakeCameraService({
      list: [
        { id: 'a', state: 'recording', frames: 1, startedAt: '2026-09-24T09:00:00.000Z' },
        { id: 'b', state: 'assembling', frames: 5, startedAt: '2026-09-24T09:01:00.000Z' },
        { id: 'c', state: 'failed', frames: 0, startedAt: '2026-09-24T09:02:00.000Z' },
      ],
    });
    const archiver = new TimelapseArchiver({ baseUrl: 'http://phi:9121', dir, fetchImpl });
    await archiver.tick();
    expect(deleted).toEqual([]);
    expect(archiver.list()).toEqual([]);
  });

  it('never deletes the camera service copy when the download fails', async () => {
    const { fetchImpl, deleted } = fakeCameraService({
      list: [{ id: 't1', state: 'ready', frames: 10, startedAt: '2026-09-24T09:00:00.000Z' }],
      downloadFails: new Set(['t1']),
    });
    const archiver = new TimelapseArchiver({ baseUrl: 'http://phi:9121', dir, fetchImpl });
    await archiver.tick();

    expect(deleted).toEqual([]);
    expect(archiver.isArchived('t1')).toBe(false);
  });

  it('retries on the next tick when the camera service is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const archiver = new TimelapseArchiver({ baseUrl: 'http://phi:9121', dir, fetchImpl });
    await expect(archiver.tick()).resolves.toBeUndefined();
  });

  it('lists archived time-lapses newest first', async () => {
    const { fetchImpl } = fakeCameraService({
      list: [
        { id: 't1', state: 'ready', frames: 1, startedAt: '2026-09-24T09:00:00.000Z' },
        { id: 't2', state: 'ready', frames: 2, startedAt: '2026-09-24T10:00:00.000Z' },
      ],
    });
    const archiver = new TimelapseArchiver({ baseUrl: 'http://phi:9121', dir, fetchImpl });
    await archiver.tick();
    expect(archiver.list().map((t) => t.id)).toEqual(['t2', 't1']);
  });

  it('has no filename when there is no history to name it from', async () => {
    const { fetchImpl } = fakeCameraService({
      list: [{ id: 't1', state: 'ready', frames: 1, startedAt: '2026-09-24T09:00:00.000Z' }],
    });
    const archiver = new TimelapseArchiver({ baseUrl: 'http://phi:9121', dir, fetchImpl });
    await archiver.tick();
    expect(archiver.info('t1')?.filename).toBeNull();
  });
});
