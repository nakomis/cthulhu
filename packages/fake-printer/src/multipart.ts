/**
 * A deliberately small multipart/form-data parser, for the fake printer only.
 *
 * Not general-purpose and not trying to be: it handles exactly what the SDCP
 * upload endpoint receives. A dependency would be the wrong trade for a test
 * double, and the real printer's parser is C on a Chitu board anyway.
 */
export interface MultipartPart {
  name: string;
  filename: string | undefined;
  data: Buffer;
}

export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];

  let index = body.indexOf(delimiter);
  if (index === -1) return parts;
  index += delimiter.length;

  for (;;) {
    // "--" immediately after the delimiter marks the end of the body.
    if (body.subarray(index, index + 2).toString() === '--') break;

    // Skip the CRLF that follows the delimiter.
    if (body.subarray(index, index + 2).toString() === '\r\n') index += 2;

    const headerEnd = body.indexOf('\r\n\r\n', index);
    if (headerEnd === -1) break;

    const headers = body.subarray(index, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;

    const next = body.indexOf(delimiter, bodyStart);
    if (next === -1) break;

    // The CRLF before the delimiter belongs to the framing, not the content -
    // including it corrupts every uploaded file by two bytes, which then shows
    // up as an MD5 mismatch and looks like a transfer fault.
    const data = body.subarray(bodyStart, next - 2);

    const nameMatch = /name="([^"]*)"/i.exec(headers);
    const filenameMatch = /filename="([^"]*)"/i.exec(headers);
    parts.push({
      name: nameMatch?.[1] ?? '',
      filename: filenameMatch?.[1],
      data,
    });

    index = next + delimiter.length;
  }

  return parts;
}
