import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { bmpToPng } from './bmp.js';

function bmp(bits: 24 | 32, topDown: boolean): Buffer {
  const width = 2;
  const height = 2;
  const bpp = bits / 8;
  const stride = Math.ceil((width * bpp) / 4) * 4;
  const out = Buffer.alloc(54 + stride * height);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(topDown ? -height : height, 22);
  out.writeUInt16LE(bits, 28);
  // Top-left red, then green; bottom row blue, white. Stored as BGR(A).
  const rows = [
    [
      [0, 0, 255],
      [0, 255, 0],
    ],
    [
      [255, 0, 0],
      [255, 255, 255],
    ],
  ];
  rows.forEach((row, y) => {
    const stored = topDown ? y : height - 1 - y;
    row.forEach((px, x) => {
      out.set(px, 54 + stored * stride + x * bpp);
    });
  });
  return out;
}

const firstPixels = (png: Buffer) => [...inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)))];

describe('bmpToPng', () => {
  it.each([
    [32, true],
    [24, false],
  ] as const)('%i-bit, top-down %s', (bits, topDown) => {
    const png = bmpToPng(bmp(bits, topDown));
    expect(png).toBeDefined();
    // Row 0: filter byte, red, green. Row 1: filter byte, blue, white.
    expect(firstPixels(png as Buffer)).toEqual([
      0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255,
    ]);
  });

  it('declines anything that is not a BMP', () => {
    expect(bmpToPng(Buffer.from('PNG and friends'))).toBeUndefined();
  });
});
