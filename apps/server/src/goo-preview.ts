import { crc32, deflateSync } from 'node:zlib';

/**
 * The slicer's preview image, from a .goo file header, as a PNG.
 *
 * Layout, checked against a file sliced for the Mars 5 Ultra: "V3.0", an
 * 8-byte magic, six fixed-width strings (software, its version, file
 * time, printer name, printer type, profile: 32+24+24+32+32+32) and three
 * 16-bit settings - 194 bytes in all - then a 116x116 thumbnail and a
 * 290x290 preview, each big-endian RGB565 and each followed by "\r\n". The
 * larger one is returned.
 *
 * Returns undefined for anything that does not look exactly like that - a
 * .ctb, a newer .goo revision - rather than a picture of garbage.
 */
export function extractGooPreview(file: Uint8Array): Buffer | undefined {
  const data = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  const MAGIC = Buffer.from([0x07, 0x00, 0x00, 0x00, 0x44, 0x4c, 0x50, 0x00]);
  if (data.subarray(0, 4).toString('latin1') !== 'V3.0') return undefined;
  if (!data.subarray(4, 12).equals(MAGIC)) return undefined;

  const HEADER = 194;
  const small = 116 * 116 * 2;
  const bigStart = HEADER + small + 2;
  const size = 290;
  const bigEnd = bigStart + size * size * 2;
  if (data.length < bigEnd + 2) return undefined;
  const crlf = (at: number) => data[at] === 0x0d && data[at + 1] === 0x0a;
  if (!crlf(HEADER + small) || !crlf(bigEnd)) return undefined;

  return rgb565ToPng(data.subarray(bigStart, bigEnd), size, size);
}

function rgb565ToPng(pixels: Buffer, width: number, height: number): Buffer {
  // One filter byte (0, none) at the start of every row, then RGB triples.
  const raw = Buffer.alloc(height * (1 + width * 3));
  let out = 0;
  for (let y = 0; y < height; y += 1) {
    raw[out++] = 0;
    for (let x = 0; x < width; x += 1) {
      const v = pixels.readUInt16BE((y * width + x) * 2);
      raw[out++] = Math.round((((v >> 11) & 0x1f) * 255) / 31);
      raw[out++] = Math.round((((v >> 5) & 0x3f) * 255) / 63);
      raw[out++] = Math.round(((v & 0x1f) * 255) / 31);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour, deflate, no filter, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0);
  return Buffer.concat([head, body, crc]);
}
