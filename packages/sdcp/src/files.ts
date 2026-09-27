import { createHash, randomUUID } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';

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

/**
 * The printer takes the file in 1 MB packets.
 *
 * Confirmed by packet capture, not just read from the spec: ChituManager
 * uploads in exactly the same 1 MiB packets. The printer advertises no such
 * constraint anywhere, so the figure is not derivable from the machine.
 */
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;

/**
 * Fields of one upload packet, in the order the printer is sent them.
 *
 * A Map rather than an object so {@link UploadOptions.tamperFields} can delete
 * a field, which is one of the failure modes worth testing.
 */
export type UploadFields = Map<string, string>;

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
  signal?: AbortSignal;
  /** Injected in tests so the uuid is predictable. */
  uuid?: string;
  /**
   * Test seam: corrupt a packet's fields after they are built but before they
   * are framed and sent. Exists so tests can reproduce the printer's own
   * failure modes — a wrong Offset, a missing or wrong MD5 — against the real
   * transport rather than a mock of it. Not for production use.
   */
  tamperFields?: (fields: UploadFields, offset: number) => void;
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
 * A filename goes into a header, so a newline or a quote in it would let the
 * caller write headers of their own. Rejected rather than escaped: the printer
 * only accepts .goo and .ctb anyway, so there is no legitimate case to support.
 */
function assertHeaderSafe(filename: string): void {
  if (/["\r\n]/.test(filename)) {
    throw new UploadError(`Refusing to upload: filename contains a quote or newline`);
  }
}

/**
 * Frame one packet as multipart/form-data, as head and tail around the file
 * bytes.
 *
 * Kept as two buffers with the slice between them, rather than one concatenated
 * body, so the 1 MB of file data is never copied — it is handed to the socket
 * as it sits in the caller's buffer.
 */
function framePacket(
  fields: UploadFields,
  filename: string,
  fileFieldName = 'File',
): { boundary: string; head: Buffer; tail: Buffer } {
  const boundary = `----------cthulhu${randomUUID().replace(/-/g, '')}`;
  const parts: string[] = [];
  for (const [name, value] of fields) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; ` +
      `filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  return {
    boundary,
    head: Buffer.from(parts.join(''), 'utf8'),
    tail: Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  };
}

interface PacketResponse {
  status: number;
  body: UploadResponse | undefined;
}

/** POST one packet over `agent`'s connection, which is reused across packets. */
function postPacket(opts: {
  agent: Agent;
  address: string;
  port: number;
  path: string;
  md5: string;
  fields: UploadFields;
  filename: string;
  slice: Uint8Array;
  signal: AbortSignal | undefined;
}): Promise<PacketResponse> {
  const { agent, address, port, path, md5, fields, filename, slice, signal } = opts;
  const { boundary, head, tail } = framePacket(fields, filename);

  return new Promise<PacketResponse>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }

    const req = httpRequest({
      host: address,
      port,
      path,
      method: 'POST',
      agent,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + slice.byteLength + tail.length,
        // Sent as a header as well as a field, which does no harm. See the
        // comment where the field is set.
        'S-File-MD5': md5,
      },
    });

    const onAbort = () => req.destroy(signal?.reason ?? new Error('Aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    // The signal outlives a single packet, so every exit has to unsubscribe or
    // a long upload accumulates one listener per megabyte.
    const settleOk = (value: PacketResponse) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const settleErr = (err: Error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    };

    req.on('error', settleErr);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', settleErr);
      res.on('end', () => {
        let body: UploadResponse | undefined;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as UploadResponse;
        } catch {
          body = undefined;
        }
        settleOk({ status: res.statusCode ?? 0, body });
      });
    });

    req.write(head);
    req.write(slice);
    req.end(tail);
  });
}

/**
 * Upload a sliced file, in 1 MB packets.
 *
 * Every packet carries the SAME Uuid and the MD5 of the WHOLE file; only
 * Offset advances. The printer reassembles by offset, which is why a mismatch
 * is its own error code (-2) rather than a generic failure.
 *
 * ## Why node:http and not fetch
 *
 * Every packet must go down the SAME TCP connection. Opening a new one to this
 * printer costs about SEVEN SECONDS — measured, three orders of magnitude worse
 * than the ~30 ms a handshake and slow start would predict. Reusing the
 * connection drops the per-packet cost to ~0.3 s, so on a 351 MB file (335
 * packets) it is the difference between about forty minutes and about two.
 *
 * `fetch` cannot be made to do it. The printer answers with a Content-Length
 * whose value is padded with trailing spaces — `"58         "` — and undici,
 * which backs global fetch, will not reuse a connection it has seen frame a
 * response that sloppily. Measured three ways against the real machine:
 *
 *     node:http, keepAlive agent   3 MiB in  7.7s   1 socket
 *     node:http, agent: false      3 MiB in 22.0s   3 sockets
 *     fetch + FormData             3 MiB in 22.0s   (undici closes each time)
 *
 * fetch is exactly as slow as deliberately opening a fresh socket per packet,
 * which is what rules out the multipart and Blob handling as the cause. There
 * is no dispatcher option to reach on the global fetch, and this package has no
 * dependencies by design, so undici cannot be imported to configure one.
 * `node:http` is in core and trims the header, so it is what we use.
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
    signal,
    uuid = randomUUID().replace(/-/g, ''),
    tamperFields,
  } = options;

  assertHeaderSafe(filename);

  const md5 = md5Of(data);
  const total = data.byteLength;
  let chunks = 0;

  // One agent per upload, destroyed when we are done with it. Per-upload rather
  // than module-level so an upload cannot leave a socket open on the printer
  // after it finishes, and so two uploads cannot contend for the same one.
  // maxSockets: 1 because the packets are strictly sequential anyway.
  const agent = new Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 10_000 });

  try {
    for (
      let offset = 0;
      offset < total || (total === 0 && offset === 0);
      offset += UPLOAD_CHUNK_BYTES
    ) {
      const slice = data.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, total));

      const fields: UploadFields = new Map([
        // S-File-MD5 as a FORM FIELD. The spec lists it with the other request
        // parameters; the Mars 5 Ultra (firmware V1.5.0) ignores the header of
        // the same name, fails every file's MD5 check, publishes sdcp/error
        // ErrorCode 1, and deletes it - while still answering success:true to
        // every packet.
        ['S-File-MD5', md5],
        ['Check', check ? '1' : '0'],
        ['Offset', String(offset)],
        ['Uuid', uuid],
        ['TotalSize', String(total)],
      ]);
      tamperFields?.(fields, offset);

      let res: PacketResponse;
      try {
        res = await postPacket({
          agent,
          address,
          port,
          path,
          md5,
          fields,
          filename,
          slice,
          signal,
        });
      } catch (err) {
        throw new UploadError(
          `Upload of ${filename} failed at offset ${offset}: ${String(err)}`,
          offset,
        );
      }

      // The endpoint answers 200 with success:false for its own errors, so the
      // status code alone is not enough.
      if (res.status < 200 || res.status >= 300 || res.body?.success === false) {
        throw new UploadError(
          `Upload of ${filename} rejected at offset ${offset} — ${describeFailure(res.body, res.status)}`,
          offset,
        );
      }

      chunks += 1;
      onProgress?.(Math.min(offset + slice.byteLength, total), total);
      if (total === 0) break;
    }
  } finally {
    agent.destroy();
  }

  return { filename, md5, size: total, uuid, chunks };
}
