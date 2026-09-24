import { createHash } from 'node:crypto';
import {
  md5Of,
  SdcpClient,
  UPLOAD_CHUNK_BYTES,
  UploadRejectedError,
  uploadFile,
} from '@cthulhu/sdcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePrinter, type FakePrinter } from './server.js';

let printer: FakePrinter;

beforeEach(async () => {
  printer = await createFakePrinter({ discovery: false, statusIntervalMs: 1000 });
});

afterEach(async () => {
  await printer.close();
});

const upload = (data: Uint8Array, filename = 'part.goo', extra = {}) =>
  uploadFile({ address: '127.0.0.1', port: printer.wsPort, filename, data, ...extra });

describe('chunked upload, per the official SDCP spec', () => {
  it('uploads a small file in a single packet', async () => {
    const data = new Uint8Array(1024).fill(7);
    const result = await upload(data);

    expect(result.chunks).toBe(1);
    expect(result.size).toBe(1024);
    expect(result.md5).toBe(md5Of(data));
    expect(printer.uploads.get('part.goo')?.md5).toBe(md5Of(data));
  });

  it('splits a file larger than 1MB into multiple packets', async () => {
    // The spec says 1 MB packets. A 2.5 MB file is three.
    const data = new Uint8Array(Math.round(UPLOAD_CHUNK_BYTES * 2.5));
    for (let i = 0; i < data.length; i += 1) data[i] = i % 251;

    const result = await upload(data, 'big.goo');
    expect(result.chunks).toBe(3);
    expect(printer.uploads.get('big.goo')?.size).toBe(data.length);
  });

  it('reassembles the bytes EXACTLY, not merely to the right length', async () => {
    // A multipart parser that keeps the framing CRLF corrupts every file by
    // two bytes per packet - which surfaces as an MD5 mismatch and reads like
    // a transfer fault rather than a parser bug.
    const data = new Uint8Array(UPLOAD_CHUNK_BYTES + 12345);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 31) % 256;

    await upload(data, 'exact.goo');
    const stored = printer.uploads.get('exact.goo');

    expect(stored?.size).toBe(data.length);
    expect(stored?.md5).toBe(createHash('md5').update(data).digest('hex'));
  });

  it('keeps one Uuid across every packet of a file', async () => {
    const data = new Uint8Array(UPLOAD_CHUNK_BYTES * 2);
    const result = await upload(data, 'uuid.goo', { uuid: 'fixed-uuid-1234' });
    expect(result.uuid).toBe('fixed-uuid-1234');
    expect(result.chunks).toBe(2);
  });

  it('reports progress as packets are accepted', async () => {
    const data = new Uint8Array(UPLOAD_CHUNK_BYTES * 2);
    const seen: number[] = [];
    await upload(data, 'prog.goo', { onProgress: (sent: number) => seen.push(sent) });

    expect(seen.length).toBe(2);
    expect(seen.at(-1)).toBe(data.length);
  });

  it("surfaces the printer's offset-mismatch code rather than a generic failure", async () => {
    // Error -2 means the client and printer disagree about what has arrived.
    // Starting mid-file with a fresh uuid reproduces it.
    const data = new Uint8Array(1024);
    await expect(
      uploadFile({
        address: '127.0.0.1',
        port: printer.wsPort,
        filename: 'bad.goo',
        data,
        uuid: 'never-seen',
        // Force a non-zero starting offset by pre-seeding nothing on the
        // printer while claiming the file is larger than we send.
        fetchImpl: async (url, init) => {
          const form = (init as { body: FormData }).body;
          form.set('Offset', '999');
          return fetch(url as string, init as RequestInit);
        },
      }),
    ).rejects.toThrow(/offset does not match/);
  });

  it('accepts every packet of a corrupted file, then rejects it on the WebSocket', async () => {
    // What the real Mars 5 Ultra does: success:true to every packet, then
    // sdcp/error ErrorCode 1 and the file deleted. An HTTP-only check calls
    // this a successful upload.
    const client = new SdcpClient({
      address: '127.0.0.1',
      port: printer.wsPort,
      mainboardId: printer.mainboardId,
    });
    client.on('error', () => {});
    await client.connect();
    try {
      const data = new Uint8Array(2048).fill(1);
      await uploadFile({
        address: '127.0.0.1',
        port: printer.wsPort,
        filename: 'corrupt.goo',
        data,
        fetchImpl: async (url, init) => {
          (init as { body: FormData }).body.set('S-File-MD5', '0'.repeat(32));
          return fetch(url as string, init as RequestInit);
        },
      });

      const verdict = client.confirmUploaded('corrupt.goo', { timeoutMs: 3000, intervalMs: 50 });
      await expect(verdict).rejects.toBeInstanceOf(UploadRejectedError);
      await expect(verdict).rejects.toMatchObject({ errorCode: 1 });
      expect(printer.uploads.has('corrupt.goo')).toBe(false);
    } finally {
      client.close();
    }
  });

  it('discards a file whose MD5 came only as a header', async () => {
    // The bug that met the real printer: the spec lists S-File-MD5 with the
    // form fields, and a header of that name is ignored.
    const data = new Uint8Array(2048).fill(3);
    await uploadFile({
      address: '127.0.0.1',
      port: printer.wsPort,
      filename: 'header-only.goo',
      data,
      fetchImpl: async (url, init) => {
        (init as { body: FormData }).body.delete('S-File-MD5');
        return fetch(url as string, init as RequestInit);
      },
    });
    expect(printer.uploads.has('header-only.goo')).toBe(false);
  });

  it('confirms a good upload by finding it in /local', async () => {
    const client = new SdcpClient({
      address: '127.0.0.1',
      port: printer.wsPort,
      mainboardId: printer.mainboardId,
    });
    client.on('error', () => {});
    await client.connect();
    try {
      await upload(new Uint8Array(4096).fill(9), 'good.goo');
      await expect(client.confirmUploaded('good.goo', { timeoutMs: 3000 })).resolves.toBe(
        '/local/good.goo',
      );
    } finally {
      client.close();
    }
  });

  it('makes an uploaded file printable', async () => {
    await upload(new Uint8Array(4096), 'printable.goo');
    expect(printer.uploads.has('printable.goo')).toBe(true);
  });
});
