import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { extractGooPreview } from './goo-preview.js';
import { PreviewStore } from './previews.js';

/** A .goo header laid out like a real one, the big preview a single colour. */
function goo({ colour = 0xf800, magic = true, crlf = true } = {}): Buffer {
  // 194, not a round number: an earlier 196 here agreed with the same
  // mistake in the decoder, and only a real file caught it.
  const header = Buffer.alloc(194);
  header.write('V3.0', 0, 'latin1');
  if (magic) Buffer.from([0x07, 0, 0, 0, 0x44, 0x4c, 0x50, 0]).copy(header, 4);
  const small = Buffer.alloc(116 * 116 * 2);
  const big = Buffer.alloc(290 * 290 * 2);
  for (let i = 0; i < big.length; i += 2) big.writeUInt16BE(colour, i);
  const sep = Buffer.from(crlf ? '\r\n' : 'xx', 'latin1');
  return Buffer.concat([header, small, sep, big, sep, Buffer.alloc(64)]);
}

/** Width, height and the first pixel of a PNG we wrote. */
function readPng(png: Buffer) {
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idatLength = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  return { width, height, firstPixel: [...raw.subarray(1, 4)] };
}

describe('extractGooPreview', () => {
  it('turns the 290x290 RGB565 preview into a PNG', () => {
    const png = extractGooPreview(goo({ colour: 0xf800 })); // pure red in RGB565
    expect(png).toBeDefined();
    expect(readPng(png as Buffer)).toEqual({ width: 290, height: 290, firstPixel: [255, 0, 0] });
  });

  it('decodes the green and blue fields too', () => {
    expect(readPng(extractGooPreview(goo({ colour: 0x07e0 })) as Buffer).firstPixel).toEqual([
      0, 255, 0,
    ]);
    expect(readPng(extractGooPreview(goo({ colour: 0x001f })) as Buffer).firstPixel).toEqual([
      0, 0, 255,
    ]);
  });

  it('declines anything that is not laid out exactly like a .goo', () => {
    expect(extractGooPreview(goo({ magic: false }))).toBeUndefined();
    expect(extractGooPreview(goo({ crlf: false }))).toBeUndefined();
    expect(extractGooPreview(goo().subarray(0, 50_000))).toBeUndefined();
    expect(extractGooPreview(Buffer.from('a .ctb, say'))).toBeUndefined();
  });
});

describe('PreviewStore', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps one preview per file name, whatever path it arrives with', () => {
    dir = mkdtempSync(join(tmpdir(), 'previews-'));
    const store = new PreviewStore(dir);
    store.save('keystamp.goo', Buffer.from('png'));
    expect(store.load('/local/keystamp.goo')?.toString()).toBe('png');
    expect(store.load('other.goo')).toBeUndefined();
  });

  it('cannot be walked out of its folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'previews-'));
    const store = new PreviewStore(dir);
    store.save('../../etc/passwd', Buffer.from('x'));
    expect(store.load('passwd')?.toString()).toBe('x');
    expect(store.load('..')).toBeUndefined();
  });
});
