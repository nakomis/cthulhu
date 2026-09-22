import { createHash } from 'node:crypto';

/**
 * File transfer to the printer.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE THINNEST PART OF THE COMMUNITY DOCUMENTATION.
 *
 * The transfer is a separate HTTP interface with an MD5 integrity check, and
 * the details are barely described. This models the shape the vendor slicer is
 * believed to use. It is the piece most likely to need rewriting once a real
 * Chitubox or Elegoo Satellite upload has been captured on the wire - see
 * CTHU-7 - so it is deliberately small and isolated.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface UploadOptions {
  address: string;
  filename: string;
  data: Uint8Array;
  /** Port serving the transfer interface. */
  port?: number;
  path?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface UploadResult {
  filename: string;
  md5: string;
  size: number;
}

export class UploadError extends Error {}

/** MD5 of the file, which the printer checks before accepting the transfer. */
export function md5Of(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

/**
 * Upload a sliced file.
 *
 * The MD5 is computed locally and sent alongside, so a corrupted transfer is
 * rejected by the printer rather than turning into a failed print hours later.
 * Ack 3 from a subsequent start-print means this check failed.
 */
export async function uploadFile(options: UploadOptions): Promise<UploadResult> {
  const {
    address,
    filename,
    data,
    port = 3030,
    path = '/uploadFile/upload',
    fetchImpl = fetch,
    signal,
  } = options;

  const md5 = md5Of(data);
  const url = new URL(`http://${address}:${port}${path}`);
  url.searchParams.set('filename', filename);
  url.searchParams.set('md5', md5);

  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method: 'POST',
      body: data,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': filename,
        'X-MD5': md5,
      },
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw new UploadError(`Upload of ${filename} failed: ${String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new UploadError(`Upload of ${filename} rejected (${res.status}): ${body.slice(0, 200)}`);
  }

  return { filename, md5, size: data.byteLength };
}
