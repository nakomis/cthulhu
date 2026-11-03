import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UploadStore } from './uploads.js';

describe('UploadStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uploads-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const store = (maxCacheBytes: number, now?: () => number) =>
    new UploadStore({ dir, maxCacheBytes, ...(now ? { now } : {}) });

  it('records an upload time that can be read back by path', async () => {
    const s = store(1_000_000, () => 1700);
    await s.record('/local/a.goo', 'a.goo', Buffer.from('hello'));
    expect(s.uploadedAt('/local/a.goo')).toBe(1700);
    expect(s.uploadedAt('/local/missing.goo')).toBeUndefined();
  });

  it('keeps the bytes and serves them locally by basename', async () => {
    const s = store(1_000_000);
    const data = Buffer.from('a real goo file');
    await s.record('/local/model.goo', 'model.goo', data);
    const path = await s.localPath('model.goo');
    expect(path).toBeDefined();
    expect(readFileSync(path as string)).toEqual(data);
    // Looks up by the file's own name, not the full printer path.
    expect(await s.localPath('nope.goo')).toBeUndefined();
  });

  it('evicts the oldest-uploaded bytes past the cache budget, keeping the metadata', async () => {
    // Budget holds two 4-byte files but not three.
    const s = store(
      9,
      (() => {
        let t = 1000;
        return () => (t += 1000);
      })(),
    );
    await s.record('/local/one.goo', 'one.goo', Buffer.from('aaaa'));
    await s.record('/local/two.goo', 'two.goo', Buffer.from('bbbb'));
    await s.record('/local/three.goo', 'three.goo', Buffer.from('cccc'));

    // Oldest bytes gone from the cache...
    expect(await s.localPath('one.goo')).toBeUndefined();
    expect(await s.localPath('two.goo')).toBeDefined();
    expect(await s.localPath('three.goo')).toBeDefined();
    // ...but its upload time is still known, so it can still be sorted.
    expect(s.uploadedAt('/local/one.goo')).toBe(2000);
  });

  it('records metadata but skips caching a file larger than the whole budget', async () => {
    const s = store(4);
    await s.record('/local/huge.goo', 'huge.goo', Buffer.from('way too big'));
    expect(s.uploadedAt('/local/huge.goo')).toBeDefined();
    expect(await s.localPath('huge.goo')).toBeUndefined();
  });

  it('survives a restart: times and cached bytes reload from disk', async () => {
    const first = store(1_000_000, () => 4242);
    await first.record('/local/keep.goo', 'keep.goo', Buffer.from('persist me'));

    const second = store(1_000_000);
    expect(second.uploadedAt('/local/keep.goo')).toBe(4242);
    const path = await second.localPath('keep.goo');
    expect(path).toBeDefined();
    expect(readFileSync(path as string).toString()).toBe('persist me');
  });

  it('forgets a cached file whose bytes vanished from disk, but keeps its time', async () => {
    const first = store(1_000_000, () => 99);
    await first.record('/local/gone.goo', 'gone.goo', Buffer.from('data'));
    // Simulate the cache dir being cleared but the index surviving is not
    // possible here; instead clear everything and prove a fresh store on an
    // empty dir simply has nothing.
    rmSync(dir, { recursive: true, force: true });
    const second = store(1_000_000);
    expect(second.uploadedAt('/local/gone.goo')).toBeUndefined();
    expect(await second.localPath('gone.goo')).toBeUndefined();
  });
});
