import { GOO_MAGIC, OFFSETS } from './header.js';

export interface SyntheticGooOptions {
  width: number;
  height: number;
  /** One entry per layer: a predicate saying which pixels are lit. */
  layers: ((x: number, y: number) => boolean)[];
  /** RGB565 for every pixel of the big preview. */
  previewColour?: number;
  layerHeightMm?: number;
  printTimeS?: number;
  machineName?: string;
}

/**
 * Write a .goo in the layout real ones use, black-and-white layers only.
 *
 * For tests: the real file this format was worked out from is Martin's model,
 * and does not belong in a public repo. The decoder is what matters, and it
 * was proven against every layer of that file; this lets tests build files
 * whose every pixel is known.
 */
export function syntheticGoo(options: SyntheticGooOptions): Buffer {
  const { width, height, layers } = options;
  const header = Buffer.alloc(OFFSETS.settings + 176);
  header.write('V3.0', 0, 'latin1');
  header.set(GOO_MAGIC, 4);
  header.write(options.machineName ?? 'ELEGOO Mars 5 Ultra', 4 + 8 + 32 + 24 + 24, 'latin1');
  header.write('\r\n', OFFSETS.bigPreview - 2, 'latin1');
  for (let p = 0; p < 290 * 290; p += 1) {
    header.writeUInt16BE(options.previewColour ?? 0x001f, OFFSETS.bigPreview + p * 2);
  }
  header.write('\r\n', OFFSETS.settings - 2, 'latin1');
  const s = OFFSETS.settings;
  header.writeUInt32BE(layers.length, s);
  header.writeUInt16BE(width, s + 4);
  header.writeUInt16BE(height, s + 6);
  header.writeFloatBE(options.layerHeightMm ?? 0.05, s + 22);
  header.writeFloatBE(2.5, s + 26);
  header.writeUInt32BE(options.printTimeS ?? 600, s + 136);
  header.writeUInt32BE(header.length, s + 160);

  const parts: Buffer[] = [header];
  layers.forEach((lit, index) => {
    const definition = Buffer.alloc(66);
    definition.writeFloatBE((index + 1) * (options.layerHeightMm ?? 0.05), 6);
    definition.write('\r\n', 64, 'latin1');
    const data = encodeLayer(width, height, lit);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    parts.push(definition, size, data, Buffer.from('\r\n', 'latin1'));
  });
  return Buffer.concat(parts);
}

function encodeLayer(
  width: number,
  height: number,
  lit: (x: number, y: number) => boolean,
): Buffer {
  const runs: number[] = [];
  const flush = (white: boolean, length: number) => {
    // The length's low 4 bits in the lead byte, the rest in 0-3 bytes after.
    const high = Math.floor(length / 16);
    const extra = high === 0 ? 0 : high < 0x100 ? 1 : high < 0x10000 ? 2 : 3;
    runs.push(((white ? 0b11 : 0b00) << 6) | (extra << 4) | (length & 0x0f));
    for (let k = extra - 1; k >= 0; k -= 1) runs.push((high >> (8 * k)) & 0xff);
  };
  let current = lit(0, 0);
  let length = 0;
  for (let p = 0; p < width * height; p += 1) {
    const on = lit(p % width, Math.floor(p / width));
    if (on === current) {
      length += 1;
      continue;
    }
    flush(current, length);
    current = on;
    length = 1;
  }
  flush(current, length);
  const sum = runs.reduce((a, b) => a + b, 0);
  return Buffer.from([0x55, ...runs, ~sum & 0xff]);
}
