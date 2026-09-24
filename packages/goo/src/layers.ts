import type { GooHeader } from './header.js';
import type { RasterImage } from './png.js';

/** Where one layer's encoded image sits in the file. */
export interface LayerRef {
  index: number;
  offset: number;
  size: number;
}

/** Reads `length` bytes at `offset` - a file handle, a buffer, anything. */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

/**
 * Each layer: a 66-byte definition (pause flag, heights, exposure, lift and
 * retract settings, PWM, "\r\n"), a big-endian u32 data size, the data, then
 * "\r\n". Walked once per file; the result is small (one entry per layer).
 */
const DEFINITION_BYTES = 66;

export async function indexLayers(read: ReadAt, header: GooHeader): Promise<LayerRef[]> {
  const refs: LayerRef[] = [];
  let offset = header.layerTableOffset;
  for (let index = 0; index < header.layerCount; index += 1) {
    const head = await read(offset, DEFINITION_BYTES + 4);
    if (head.length < DEFINITION_BYTES + 4)
      throw new LayerDecodeError(`Layer ${index} is truncated`);
    if (head[DEFINITION_BYTES - 2] !== 0x0d || head[DEFINITION_BYTES - 1] !== 0x0a) {
      throw new LayerDecodeError(`Layer ${index} definition is not where the header says`);
    }
    const size = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(
      DEFINITION_BYTES,
    );
    refs.push({ index, offset: offset + DEFINITION_BYTES + 4, size });
    offset += DEFINITION_BYTES + 4 + size + 2;
  }
  return refs;
}

export class LayerDecodeError extends Error {}

export interface DecodeOptions {
  width: number;
  height: number;
  /** Shrink by this factor in both directions: 10 turns 8520 wide into 852. */
  scale: number;
  /** Flip left to right, to undo the LCD's mirroring. */
  mirrorX?: boolean;
}

/**
 * One layer's image, decoded and scaled down in a single pass.
 *
 * The encoding, as found in real files: 0x55, then runs, then a checksum
 * byte - the bitwise NOT of the low byte of the sum of the runs' bytes. Each
 * run starts with a byte whose top two bits say what it is:
 *
 *   00  black         )  the length's low 4 bits are this byte's low 4 bits;
 *   11  white         )  bits 4-5 say how many more bytes (0-3) hold the
 *   01  grey (next    )  rest, big-endian, ABOVE those 4 bits - so d6 15 is
 *       byte = value) )  white x (0x15 << 4 | 6) = 342 pixels
 *   10  a step from the previous value: bits 4-5 = up 1 pixel, up with a
 *       count byte, down 1 pixel, down with a count byte; low 4 bits = step
 *
 * Black, white and the length rule are verified: all 893 layers of a real
 * file decode to exactly 8520 x 4320 with matching checksums. Grey and step
 * runs come from anti-aliased slicing, which that file did not use, so they
 * follow the format's description unverified - and the pixel-count and
 * checksum checks refuse a layer rather than show it wrong.
 */
export function decodeLayer(data: Uint8Array, options: DecodeOptions): RasterImage {
  const { width, height, scale, mirrorX = false } = options;
  if (data[0] !== 0x55) throw new LayerDecodeError('Layer data does not start with 0x55');

  const end = data.length - 1;
  let sum = 0;
  for (let i = 1; i < end; i += 1) sum += data[i] ?? 0;
  if ((~sum & 0xff) !== data[end]) throw new LayerDecodeError('Layer checksum does not match');

  const outW = Math.ceil(width / scale);
  const outH = Math.ceil(height / scale);
  const acc = new Float64Array(outW * outH);
  const total = width * height;
  let pixel = 0;
  let value = 0;

  const paint = (length: number, colour: number) => {
    if (pixel + length > total) throw new LayerDecodeError('Layer decodes to too many pixels');
    if (colour === 0) {
      pixel += length;
      return;
    }
    let left = length;
    while (left > 0) {
      const row = Math.floor(pixel / width);
      const col = pixel % width;
      const segment = Math.min(left, width - col);
      const rowBase = Math.floor(row / scale) * outW;
      const last = col + segment;
      for (let cx = Math.floor(col / scale); cx * scale < last; cx += 1) {
        const overlap = Math.min((cx + 1) * scale, last) - Math.max(cx * scale, col);
        acc[rowBase + cx] = (acc[rowBase + cx] ?? 0) + overlap * colour;
      }
      pixel += segment;
      left -= segment;
    }
  };

  let i = 1;
  while (i < end) {
    const b = data[i] ?? 0;
    const type = b >> 6;
    const extra = (b >> 4) & 0x3;
    if (type === 0b10) {
      const step = b & 0x0f;
      value = extra < 2 ? value + step : value - step;
      let length = 1;
      if (extra === 1 || extra === 3) {
        i += 1;
        length = data[i] ?? 0;
      }
      paint(length, Math.max(0, Math.min(255, value)));
      i += 1;
      continue;
    }
    if (type === 0b01) {
      i += 1;
      value = data[i] ?? 0;
    } else {
      value = type === 0b11 ? 255 : 0;
    }
    let high = 0;
    for (let k = 0; k < extra; k += 1) {
      i += 1;
      high = high * 256 + (data[i] ?? 0);
    }
    paint(high * 16 + (b & 0x0f), value);
    i += 1;
  }
  if (pixel !== total) {
    throw new LayerDecodeError(`Layer decodes to ${pixel} pixels, expected ${total}`);
  }

  const out = new Uint8Array(outW * outH);
  for (let cy = 0; cy < outH; cy += 1) {
    const cellH = Math.min(scale, height - cy * scale);
    for (let cx = 0; cx < outW; cx += 1) {
      const cellW = Math.min(scale, width - cx * scale);
      const x = mirrorX ? outW - 1 - cx : cx;
      out[cy * outW + x] = Math.round((acc[cy * outW + cx] ?? 0) / (cellW * cellH));
    }
  }
  return { width: outW, height: outH, channels: 1, data: out };
}
