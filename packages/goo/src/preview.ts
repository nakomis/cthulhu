import { BIG_PREVIEW, isGoo, OFFSETS, SMALL_PREVIEW } from './header.js';
import { encodePng } from './png.js';

/**
 * The slicer's 290x290 preview from a .goo header, as a PNG - or undefined
 * for anything not laid out exactly like one (a .ctb, a newer revision),
 * rather than a picture of garbage. Needs only the first HEADER_BYTES.
 */
export function extractGooPreview(file: Uint8Array): Buffer | undefined {
  if (!isGoo(file)) return undefined;
  const smallEnd = OFFSETS.smallPreview + SMALL_PREVIEW.width * SMALL_PREVIEW.height * 2;
  const bigEnd = OFFSETS.bigPreview + BIG_PREVIEW.width * BIG_PREVIEW.height * 2;
  if (file.length < bigEnd + 2) return undefined;
  const crlf = (at: number) => file[at] === 0x0d && file[at + 1] === 0x0a;
  if (!crlf(smallEnd) || !crlf(bigEnd)) return undefined;

  const { width, height } = BIG_PREVIEW;
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p += 1) {
    const at = OFFSETS.bigPreview + p * 2;
    // Big-endian RGB565.
    const v = ((file[at] ?? 0) << 8) | (file[at + 1] ?? 0);
    rgb[p * 3] = Math.round((((v >> 11) & 0x1f) * 255) / 31);
    rgb[p * 3 + 1] = Math.round((((v >> 5) & 0x3f) * 255) / 63);
    rgb[p * 3 + 2] = Math.round(((v & 0x1f) * 255) / 31);
  }
  return encodePng({ width, height, channels: 3, data: rgb });
}
