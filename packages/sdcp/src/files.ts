import { createHash, randomUUID } from 'node:crypto';

/**
 * File transfer to the printer.
 *
 * Implemented against the OFFICIAL specification, which is written for resin
 * printers:
 *   https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0
 *
 * An earlier version of this file guessed the shape from community
 * documentation for the Centauri Carbon (an FDM machine) and sent the whole
 * file in one POST with query parameters. Only the endpoint path was right.
 */

/** The printer takes the file in 1 MB packets. */
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;

export interface UploadOptions {
  address: string;
  filename: string;
  data: Uint8Array;
  /** Port serving the transfer interface. The spec says 3030, same as the WS. */
  port?: number;
  path?: string;
  /** Ask the printer to verify the MD5. On by default; there is no good reason not to. */
  check?: boolean;
  /** Called after each accepted packet, for progress reporting. */
  onProgress?: (sent: number, total: number) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Injected in tests so the uuid is predictable. */
  uuid?: string;
}

export interface UploadResult {
  filename: string;
  md5: string;
  size: number;
  uuid: string;
  chunks: number;
}

export class UploadError extends Error {
  readonly offset: number | undefined;

  constructor(message: string, offset?: number) {
    super(message);
    this.offset = offset;
  }
}

/** Documented failure codes from the upload endpoint. */
export const UPLOAD_ERRORS: Record<string, string> = {
  '-1': 'illegal file offset (less than 0)',
  '-2': 'file offset does not match the current file',
  '-3': 'file could not be opened on the printer',
  '-4': 'unknown error',
};

/** MD5 of the file, which the printer checks before accepting the transfer. */
export function md5Of(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

interface UploadResponse {
  code?: string;
  success?: boolean;
  messages?: { field?: string; message?: string }[] | null;
}

function describeFailure(body: UploadResponse | undefined, status: number): string {
  if (!body) return `HTTP ${status}`;
  const code = body.code ?? String(status);
  const documented = UPLOAD_ERRORS[code];
  const messages = (body.messages ?? [])
    .map((m) => m?.message)
    .filter(Boolean)
    .join('; ');
  return [documented ? `${code}: ${documented}` : `code ${code}`, messages]
    .filter(Boolean)
    .join(' — ');
}

/**
 * Upload a sliced file, in 1 MB packets.
 *
 * Every packet carries the SAME Uuid and the MD5 of the WHOLE file; only
 * Offset advances. The printer reassembles by offset, which is why a mismatch
 * is its own error code (-2) rather than a generic failure.
 */
export async function uploadFile(options: UploadOptions): Promise<UploadResult> {
  const {
    address,
    filename,
    data,
    port = 3030,
    path = '/uploadFile/upload',
    check = true,
    onProgress,
    fetchImpl = fetch,
    signal,
    uuid = randomUUID().replace(/-/g, ''),
  } = options;

  const md5 = md5Of(data);
  const total = data.byteLength;
  const url = `http://${address}:${port}${path}`;
  let chunks = 0;

  for (
    let offset = 0;
    offset < total || (total === 0 && offset === 0);
    offset += UPLOAD_CHUNK_BYTES
  ) {
    const slice = data.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, total));

    const form = new FormData();
    form.set('Check', check ? '1' : '0');
    form.set('Offset', String(offset));
    form.set('Uuid', uuid);
    form.set('TotalSize', String(total));
    // Copied into a fresh array: subarray() shares the caller's buffer, which
    // may be SharedArrayBuffer-backed, and Blob requires plain ArrayBuffer.
    // One 1 MB copy per packet is a fair price for not constraining callers.
    form.set('File', new Blob([new Uint8Array(slice)]), filename);

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        // NOT Content-Type: fetch must set the multipart boundary itself.
        headers: { 'S-File-MD5': md5 },
        body: form,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new UploadError(
        `Upload of ${filename} failed at offset ${offset}: ${String(err)}`,
        offset,
      );
    }

    let body: UploadResponse | undefined;
    try {
      body = (await res.json()) as UploadResponse;
    } catch {
      body = undefined;
    }

    // The endpoint answers 200 with success:false for its own errors, so the
    // status code alone is not enough.
    if (!res.ok || body?.success === false) {
      throw new UploadError(
        `Upload of ${filename} rejected at offset ${offset} — ${describeFailure(body, res.status)}`,
        offset,
      );
    }

    chunks += 1;
    onProgress?.(Math.min(offset + slice.byteLength, total), total);
    if (total === 0) break;
  }

  return { filename, md5, size: total, uuid, chunks };
}
