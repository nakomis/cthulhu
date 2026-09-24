import { encodePng } from './png.js';

/**
 * A Windows BMP, as the printer renders its thumbnails, to PNG.
 *
 * Handles what the Mars 5 Ultra produces - uncompressed 24- or 32-bit, rows
 * either way up (its are top-down: negative height) - and returns undefined
 * for anything else.
 */
export function bmpToPng(bmp: Uint8Array): Buffer | undefined {
  if (bmp.length < 54 || bmp[0] !== 0x42 || bmp[1] !== 0x4d) return undefined;
  const view = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  const pixelOffset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bits = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  // 0 BI_RGB; 3 BI_BITFIELDS, which for 32-bit is the same BGRA layout here.
  if ((bits !== 24 && bits !== 32) || (compression !== 0 && compression !== 3)) return undefined;
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bytesPerPixel = bits / 8;
  const stride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  if (width <= 0 || pixelOffset + stride * height > bmp.length) return undefined;

  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const row = pixelOffset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x += 1) {
      const at = row + x * bytesPerPixel;
      const out = (y * width + x) * 3;
      rgb[out] = bmp[at + 2] ?? 0;
      rgb[out + 1] = bmp[at + 1] ?? 0;
      rgb[out + 2] = bmp[at] ?? 0;
    }
  }
  return encodePng({ width, height, channels: 3, data: rgb });
}
