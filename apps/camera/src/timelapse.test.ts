import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTimelapseId, TimelapseStore } from './timelapse.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timelapse-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An ffmpeg that writes a fake video to its last argument and exits `code`. */
function fakeFfmpeg(code = 0) {
  return vi.fn((_bin: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stderr: PassThrough };
    child.stderr = new PassThrough();
    setImmediate(() => {
      if (code === 0) writeFileSync(args.at(-1) as string, 'MP4');
      else child.stderr.write('broken');
      child.emit('close', code);
    });
    return child;
  });
}

const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

describe('TimelapseStore', () => {
  it('records frames by layer, then assembles and deletes them', async () => {
    const spawnImpl = fakeFfmpeg();
    const store = new TimelapseStore({ dir, spawnImpl: spawnImpl as never });
    store.start('task-1');
    store.addFrame('task-1', 0, jpeg);
    store.addFrame('task-1', 1, jpeg);
    // The same layer twice (a repeated status frame) is one frame, not two.
    expect(store.addFrame('task-1', 1, jpeg).frames).toBe(2);

    const done = await store.finish('task-1');
    expect(done).toMatchObject({ state: 'ready', frames: 2, bytes: 3 });
    expect(readFileSync(store.videoPath('task-1') as string, 'utf8')).toBe('MP4');
    expect(existsSync(join(dir, 'task-1'))).toBe(false);

    const args = spawnImpl.mock.calls[0]?.[1] as string[];
    expect(args).toContain('glob');
    expect(args).toContain('+faststart');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
  });

  it('carries on after a restart, from what is on disk', () => {
    new TimelapseStore({ dir }).addFrame('task-2', 5, jpeg);
    const again = new TimelapseStore({ dir });
    expect(again.info('task-2')).toMatchObject({ state: 'recording', frames: 1 });
    expect(again.list().map((t) => t.id)).toEqual(['task-2']);
  });

  it('fails with the reason when ffmpeg does, or when nothing was captured', async () => {
    const store = new TimelapseStore({ dir, spawnImpl: fakeFfmpeg(1) as never });
    store.addFrame('task-3', 0, jpeg);
    expect(await store.finish('task-3')).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('broken'),
    });

    store.start('task-4');
    expect(await store.finish('task-4')).toMatchObject({
      state: 'failed',
      error: 'No frames were captured',
    });
  });

  it('deletes a finished time-lapse: video, metadata and any leftover frames', async () => {
    const store = new TimelapseStore({ dir, spawnImpl: fakeFfmpeg() as never });
    store.addFrame('task-5', 0, jpeg);
    await store.finish('task-5');
    expect(existsSync(join(dir, 'task-5.mp4'))).toBe(true);

    expect(store.remove('task-5')).toBe(true);
    expect(existsSync(join(dir, 'task-5.mp4'))).toBe(false);
    expect(store.info('task-5')).toBeUndefined();

    // Nothing to delete the second time, and never throws.
    expect(store.remove('task-5')).toBe(false);
  });

  it('refuses to delete anything but a time-lapse id', () => {
    const store = new TimelapseStore({ dir });
    expect(store.remove('../etc')).toBe(false);
  });

  it('only ever turns a task id into a path', () => {
    expect(isTimelapseId('e0b0890e-b803-11f1-9526-3c1accf1b2e1')).toBe(true);
    for (const bad of ['../etc', 'a/b', '', 'x'.repeat(65)]) expect(isTimelapseId(bad)).toBe(false);
  });

  const hasFfmpeg = (() => {
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { stdio: 'pipe' })
        .toString()
        .includes('libx264');
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasFfmpeg)('makes a playable MP4 with the real ffmpeg', async () => {
    // Three 64x48 frames from ffmpeg's own test source, as JPEGs.
    const frames = join(dir, 'src');
    execFileSync('mkdir', ['-p', frames]);
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x48:rate=3',
      '-frames:v',
      '3',
      join(frames, '%d.jpg'),
    ]);
    const store = new TimelapseStore({ dir: join(dir, 'tl'), spawnImpl: spawn });
    for (const n of [1, 2, 3])
      store.addFrame('real', n * 10, readFileSync(join(frames, `${n}.jpg`)));

    const done = await store.finish('real');
    expect(done.state).toBe('ready');
    const probe = execFileSync('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,pix_fmt,nb_read_frames',
      '-of',
      'csv=p=0',
      store.videoPath('real') as string,
    ])
      .toString()
      .trim();
    expect(probe).toBe('h264,yuv420p,3');
  });
});
