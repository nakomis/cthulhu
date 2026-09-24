import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractGooPreview, HEADER_BYTES, parseGooHeader } from '@cthulhu/goo';
import { isPrintFile, mediaPath, mediaUrl } from './printer-media.js';

export interface FileMeta {
  layerCount: number;
  layerHeightMm: number;
  /** The slicer's estimate, in seconds. */
  printTimeS: number;
  machineName: string;
  preview: boolean;
}

export interface FileMetaOptions {
  dir: string;
  port: number;
  fetchImpl?: typeof fetch;
}

/**
 * A print file's preview and details, from its first ~195 KB.
 *
 * One range request per file, whether it is in internal storage or on the
 * USB stick, and whoever put it there. Cached on disk by path AND size, so a
 * file re-uploaded under the same name is read afresh; a HEAD request (a
 * handful of bytes) checks the size each time.
 */
export class FileMetaCache {
  private readonly dir: string;
  private readonly port: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FileMetaOptions) {
    this.dir = options.dir;
    this.port = options.port;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async meta(address: string, path: string): Promise<FileMeta | undefined> {
    return (await this.load(address, path))?.meta;
  }

  async preview(address: string, path: string): Promise<Buffer | undefined> {
    const entry = await this.load(address, path);
    if (!entry?.meta.preview) return undefined;
    try {
      return readFileSync(`${entry.key}.png`);
    } catch {
      return undefined;
    }
  }

  private async load(
    address: string,
    path: string,
  ): Promise<{ key: string; meta: FileMeta } | undefined> {
    const media = mediaPath(path);
    if (!isPrintFile(media) || !/\.goo$/i.test(media)) return undefined;
    const url = mediaUrl(address, this.port, media);

    const head = await this.fetchImpl(url, { method: 'HEAD' });
    if (!head.ok) return undefined;
    const size = head.headers.get('content-length') ?? '0';
    const key = join(this.dir, createHash('sha1').update(`${media}\0${size}`).digest('hex'));
    try {
      return { key, meta: JSON.parse(readFileSync(`${key}.json`, 'utf8')) as FileMeta };
    } catch {
      // Not cached yet.
    }

    const res = await this.fetchImpl(url, { headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } });
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const header = parseGooHeader(bytes);
    if (!header) return undefined;
    const png = extractGooPreview(bytes);
    const meta: FileMeta = {
      layerCount: header.layerCount,
      layerHeightMm: header.layerHeightMm,
      printTimeS: header.printTimeS,
      machineName: header.machineName,
      preview: png !== undefined,
    };
    mkdirSync(this.dir, { recursive: true });
    if (png) writeFileSync(`${key}.png`, png);
    writeFileSync(`${key}.json`, JSON.stringify(meta));
    return { key, meta };
  }
}
