import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  bmpToPng,
  decodeLayer,
  encodePng,
  type GooHeader,
  HEADER_BYTES,
  indexLayers,
  type LayerRef,
  parseGooHeader,
} from '@cthulhu/goo';
import { isPrintFile, mediaPath, mediaUrl } from './printer-media.js';

/** What Cmd 321 says about a task, as far as this needs it. */
export interface TaskDetail {
  /** The printer's own path to the file: /media/mmcblk0p3/keystamp.goo. */
  taskName: string;
  thumbnailUrl: string | undefined;
}

export type LayerResult =
  | { state: 'ready'; layer: number; png: Buffer }
  | { state: 'downloading'; received: number; total: number | undefined }
  | { state: 'failed'; error: string };

export interface PrintViewOptions {
  dir: string;
  port: number;
  /** Cmd 321, for the task's file path and thumbnail. */
  detail: (taskId: string) => Promise<TaskDetail | undefined>;
  fetchImpl?: typeof fetch;
  /** Shrink layers by this factor: 10 turns 8520 x 4320 into 852 x 432. */
  scale?: number;
  log?: (line: string) => void;
}

interface Task {
  taskId: string;
  file: string;
  received: number;
  total: number | undefined;
  ready?: { header: GooHeader; refs: LayerRef[] };
  error?: string;
  thumbnail?: Buffer;
  last?: { layer: number; png: Buffer };
}

/**
 * The layer being printed, as an image, the way the Elegoo app shows it.
 *
 * The printer does not supply layer images; they are inside the print file.
 * So the file is fetched from the printer's own web server once per print -
 * about 45 s for 13 MB over its WiFi - kept on disk, and each layer decoded
 * when somebody asks (a few ms: a layer is a few thousand runs).
 */
export class PrintView {
  private readonly options: PrintViewOptions;
  private readonly fetchImpl: typeof fetch;
  private task: Task | undefined;
  private preparing: Promise<void> | undefined;

  constructor(options: PrintViewOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The printer's own 400x300 thumbnail of the task, as PNG. */
  async thumbnail(address: string, taskId: string): Promise<Buffer | undefined> {
    const task = this.task?.taskId === taskId ? this.task : undefined;
    if (task?.thumbnail) return task.thumbnail;
    const detail = await this.options.detail(taskId);
    // Only ever follow a thumbnail address on the printer itself.
    if (!detail?.thumbnailUrl?.startsWith(`http://${address}:`)) return undefined;
    const res = await this.fetchImpl(detail.thumbnailUrl);
    if (!res.ok) return undefined;
    const png = bmpToPng(new Uint8Array(await res.arrayBuffer()));
    if (png && task) task.thumbnail = png;
    return png;
  }

  /** Start fetching a task's file, if that has not already begun. */
  prepare(address: string, taskId: string): Promise<void> {
    if (this.task?.taskId === taskId && this.preparing) return this.preparing;
    if (this.task?.taskId === taskId && (this.task.ready || this.task.error)) {
      return Promise.resolve();
    }
    const file = join(this.options.dir, `${taskId}.goo`);
    this.task = { taskId, file, received: 0, total: undefined };
    const task = this.task;
    this.preparing = this.download(address, task)
      .catch((err: unknown) => {
        task.error = err instanceof Error ? err.message : String(err);
        this.options.log?.(`print view: ${task.error}`);
      })
      .finally(() => {
        if (this.task === task) this.preparing = undefined;
      });
    return this.preparing;
  }

  /** Layer `index` (0-based: the printer's CurrentLayer) of a task. */
  async layer(address: string, taskId: string, index: number): Promise<LayerResult> {
    void this.prepare(address, taskId);
    const task = this.task;
    if (!task || task.taskId !== taskId) return { state: 'failed', error: 'No such task' };
    if (task.error) return { state: 'failed', error: task.error };
    if (!task.ready) return { state: 'downloading', received: task.received, total: task.total };

    const { header, refs } = task.ready;
    const layer = Math.max(0, Math.min(index, refs.length - 1));
    if (task.last?.layer === layer) return { state: 'ready', layer, png: task.last.png };
    const ref = refs[layer] as LayerRef;
    const handle = await open(task.file);
    try {
      const data = Buffer.alloc(ref.size);
      await handle.read(data, 0, ref.size, ref.offset);
      // Not mirrored: the stored image already matches the slicer's view.
      const png = encodePng(
        decodeLayer(data, {
          width: header.resolutionX,
          height: header.resolutionY,
          scale: this.options.scale ?? 10,
        }),
      );
      task.last = { layer, png };
      return { state: 'ready', layer, png };
    } finally {
      await handle.close();
    }
  }

  private async download(address: string, task: Task): Promise<void> {
    const detail = await this.options.detail(task.taskId);
    if (!detail) throw new Error(`The printer has no details for task ${task.taskId}`);
    const media = mediaPath(detail.taskName);
    if (!isPrintFile(media) || !/\.goo$/i.test(media)) {
      throw new Error(`Layer images need a .goo file; this print is ${media}`);
    }

    await mkdir(this.options.dir, { recursive: true });
    // One print at a time: anything left from an earlier task is stale.
    for (const name of await readdir(this.options.dir)) {
      if (!name.startsWith(task.taskId)) await rm(join(this.options.dir, name), { force: true });
    }

    const res = await this.fetchImpl(mediaUrl(address, this.options.port, media));
    if (!res.ok || !res.body) throw new Error(`The printer answered ${res.status} for ${media}`);
    const length = Number(res.headers.get('content-length'));
    task.total = Number.isFinite(length) && length > 0 ? length : undefined;
    const counted = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    counted.on('data', (chunk: Buffer) => {
      task.received += chunk.length;
    });
    const part = `${task.file}.part`;
    await pipeline(counted, createWriteStream(part));
    await rename(part, task.file);

    const handle = await open(task.file);
    try {
      const read = async (offset: number, length: number) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      };
      const header = parseGooHeader(await read(0, HEADER_BYTES));
      if (!header) throw new Error(`${media} is not a .goo this understands`);
      task.ready = { header, refs: await indexLayers(read, header) };
      this.options.log?.(`print view: ${media} ready, ${header.layerCount} layers`);
    } finally {
      await handle.close();
    }
  }
}
