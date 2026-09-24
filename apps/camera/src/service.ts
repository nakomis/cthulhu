import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { PassThrough } from 'node:stream';
import { CameraProxy, LatestFrame, parseRange, type UpstreamHandle } from '@cthulhu/camera';
import { isTimelapseId, type TimelapseStore } from './timelapse.js';

export interface CameraServiceOptions {
  /** Opens the one upstream; called only while somebody is watching. */
  openUpstream: () => Promise<UpstreamHandle>;
  /** Where time-lapses are kept. Without it, the /timelapse routes 404. */
  timelapse?: TimelapseStore;
  /** How old the latest frame may be and still count as "now". */
  maxFrameAgeMs?: number;
  log?: (line: string) => void;
}

/**
 * MJPEG over HTTP, for cthulhu to consume as its CAMERA_URL.
 *
 * This exists to move the decode and encode off Luke, whose two 1.5 GHz cores
 * could not keep up. It deliberately knows nothing about SDCP: cthulhu still
 * sends Cmd 386 to turn the printer's stream on before connecting here, and
 * off again when it leaves. This end only pulls the RTSP stream, shares it
 * between whoever connects, and stops ffmpeg when the last one goes.
 */
export function createCameraService(options: CameraServiceOptions): {
  server: Server;
  proxy: CameraProxy;
  latest: LatestFrame;
} {
  const { log = () => {}, timelapse, maxFrameAgeMs = 1500 } = options;
  // Every upstream is watched for its latest whole frame: that is what a
  // time-lapse takes, the moment cthulhu says the plate is at the top.
  const latest = new LatestFrame();
  const proxy = new CameraProxy({
    openUpstream: async () => {
      const handle = await options.openUpstream();
      handle.stream.on('data', (chunk: Buffer) => latest.push(chunk));
      return handle;
    },
  });

  // A recording time-lapse holds the stream open with a viewer that throws
  // the bytes away, so frames keep coming between browsers' visits.
  const holds = new Map<string, PassThrough>();
  const hold = async (id: string) => {
    if (holds.has(id)) return;
    const viewer = await proxy.addViewer();
    viewer.resume();
    viewer.on('close', () => holds.delete(id));
    holds.set(id, viewer);
    log(`time-lapse ${id}: holding the stream`);
  };
  const release = (id: string) => {
    holds.get(id)?.destroy();
    holds.delete(id);
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;

    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          viewers: proxy.viewerCount,
          upstreamOpen: proxy.upstreamOpen,
        }),
      );
      return;
    }

    if (path === '/video' && req.method === 'GET') {
      let viewer: Awaited<ReturnType<CameraProxy['addViewer']>>;
      try {
        viewer = await proxy.addViewer();
      } catch (err) {
        log(`camera: upstream failed: ${String(err)}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Camera unavailable: ${String(err)}` }));
        return;
      }
      log(`camera: viewer joined (${proxy.viewerCount} watching)`);
      res.writeHead(200, {
        // ffmpeg's mpjpeg muxer, told -boundary_tag frame.
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-store',
      });
      // Now, not with the first frame: that can be seconds away, waiting on
      // a keyframe, and until then the client has no response at all.
      res.flushHeaders();
      viewer.pipe(res);
      // The viewer leaving is what lets the proxy stop ffmpeg. Logged from
      // the viewer's own close, after the proxy has counted it out.
      viewer.on('close', () => log(`camera: viewer left (${proxy.viewerCount} watching)`));
      res.on('close', () => viewer.destroy());
      return;
    }

    const route = /^\/timelapse\/([^/]+?)(\.mp4|\/start|\/frame|\/finish)?$/.exec(path);
    if (timelapse && path === '/timelapse' && req.method === 'GET') {
      json(res, 200, timelapse.list());
      return;
    }
    if (timelapse && route) {
      const id = route[1] as string;
      const action = route[2];
      if (!isTimelapseId(id)) {
        json(res, 400, { error: 'Not a time-lapse id' });
        return;
      }
      if (action === '/start' && req.method === 'POST') {
        const info = timelapse.start(id);
        await hold(id).catch((err) => log(`time-lapse ${id}: cannot hold the stream: ${err}`));
        json(res, 200, info);
        return;
      }
      if (action === '/frame' && req.method === 'POST') {
        const layer = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('layer'));
        if (!Number.isInteger(layer) || layer < 0) {
          json(res, 400, { error: 'layer must be a whole number' });
          return;
        }
        // After a restart mid-print, the first frame picks the hold back up.
        await hold(id).catch(() => {});
        const jpeg = latest.latest(maxFrameAgeMs);
        if (!jpeg) {
          json(res, 409, { error: 'No fresh frame from the camera' });
          return;
        }
        json(res, 200, timelapse.addFrame(id, layer, jpeg));
        return;
      }
      if (action === '/finish' && req.method === 'POST') {
        release(id);
        // Assembly takes a while; answer now and let it run.
        void timelapse.finish(id);
        json(res, 202, timelapse.info(id) ?? { id });
        return;
      }
      if (action === '.mp4' && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = timelapse.videoPath(id);
        if (!file) {
          json(res, 404, { error: 'No finished video for that time-lapse' });
          return;
        }
        sendFile(res, file, req.headers.range, req.method === 'HEAD');
        return;
      }
      if (!action && req.method === 'GET') {
        const info = timelapse.info(id);
        json(res, info ? 200 : 404, info ?? { error: 'No such time-lapse' });
        return;
      }
      if (!action && req.method === 'DELETE') {
        // Called by the server once it has archived its own copy to the
        // share, so the camera service does not keep a second copy forever.
        const removed = timelapse.remove(id);
        json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'No such time-lapse' });
        return;
      }
    }

    res.writeHead(404).end();
  };

  // A throw in one request must not take the service down: an EACCES writing
  // a time-lapse frame once crash-looped it, reopening the printer's RTSP on
  // every restart until the printer stopped serving video (CTHU-22).
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log(`${req.method} ${req.url} failed: ${String(err)}`);
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: String(err) });
    });
  });

  server.on('close', () => {
    for (const id of holds.keys()) release(id);
    void proxy.close();
  });
  return { server, proxy, latest };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** A file, honouring a single Range - which is what lets a <video> seek. */
function sendFile(
  res: ServerResponse,
  file: string,
  range: string | undefined,
  headOnly: boolean,
): void {
  const size = statSync(file).size;
  const result = parseRange(range, size);
  if (result === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    return;
  }
  const { start, end, partial } = result;
  res.writeHead(partial ? 206 : 200, {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(file, { start, end }).pipe(res);
}
