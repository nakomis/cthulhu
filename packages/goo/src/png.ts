import { crc32, deflateSync } from 'node:zlib';

export interface RasterImage {
  width: number;
  height: number;
  /** 1 = greyscale, 3 = RGB. Rows top to bottom, no padding. */
  channels: 1 | 3;
  data: Uint8Array;
}

/** A minimal PNG encoder: 8-bit, no filtering, one IDAT. Enough for previews. */
export function encodePng(image: RasterImage): Buffer {
  const { width, height, channels, data } = image;
  const stride = width * channels;
  if (data.length !== stride * height) {
    throw new Error(`Image data is ${data.length} bytes, expected ${stride * height}`);
  }
  // A filter-type byte (0, none) at the start of every row.
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  // 8 bits; colour type 0 greyscale or 2 truecolour; deflate; no filter; no interlace.
  ihdr.set([8, channels === 1 ? 0 : 2, 0, 0, 0], 8);
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
