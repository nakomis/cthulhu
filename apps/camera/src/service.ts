import { createServer, type Server } from 'node:http';
import { CameraProxy, type UpstreamHandle } from '@cthulhu/camera';

export interface CameraServiceOptions {
  /** Opens the one upstream; called only while somebody is watching. */
  openUpstream: () => Promise<UpstreamHandle>;
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
} {
  const { log = () => {} } = options;
  const proxy = new CameraProxy({ openUpstream: options.openUpstream });

  const server = createServer(async (req, res) => {
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

    res.writeHead(404).end();
  });

  server.on('close', () => void proxy.close());
  return { server, proxy };
}
