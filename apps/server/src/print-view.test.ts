import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syntheticGoo } from '@cthulhu/goo';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrintView } from './print-view.js';

describe('PrintView upload cache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pv-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads layers from a local upload copy, without fetching from the printer', async () => {
    const goo = syntheticGoo({ width: 80, height: 40, layers: [() => true, (x) => x < 40] });
    const localPath = join(dir, 'model.goo');
    writeFileSync(localPath, goo);

    // Any network fetch here is a failure: the whole point is to avoid it.
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('PrintView fetched from the printer despite a local copy');
    });

    const view = new PrintView({
      dir: join(dir, 'print-files'),
      port: 3030,
      detail: async () => ({ taskName: '/media/mmcblk0p3/model.goo', thumbnailUrl: undefined }),
      findLocal: async (name) => (name === 'model.goo' ? localPath : undefined),
      fetchImpl,
    });

    await view.prepare('127.0.0.1', 'task-1');
    const result = await view.layer('127.0.0.1', 'task-1', 0);
    expect(result.state).toBe('ready');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to the printer when there is no local copy', async () => {
    const goo = syntheticGoo({ width: 80, height: 40, layers: [() => true] });
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(goo, { status: 200, headers: { 'content-length': String(goo.length) } }),
    );

    const view = new PrintView({
      dir: join(dir, 'print-files'),
      port: 3030,
      detail: async () => ({ taskName: '/media/mmcblk0p3/other.goo', thumbnailUrl: undefined }),
      findLocal: async () => undefined,
      fetchImpl,
    });

    await view.prepare('127.0.0.1', 'task-2');
    const result = await view.layer('127.0.0.1', 'task-2', 0);
    expect(result.state).toBe('ready');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
