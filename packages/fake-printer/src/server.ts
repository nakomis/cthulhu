import { createHash, randomUUID } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Cmd,
  DISCOVERY_PAYLOAD,
  DISCOVERY_PORT,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  MAX_VIDEO_STREAMS,
  StartPrintAck,
  topics,
} from '@cthulhu/sdcp';
import { type WebSocket, WebSocketServer } from 'ws';
import { MARS_5_ULTRA, type PrinterFixture } from './fixtures.js';
import { parseMultipart } from './multipart.js';
import { PrinterState } from './state.js';
import { type FrameSource, frameSourceFromEnv } from './video.js';

export interface FakePrinterOptions {
  fixture?: PrinterFixture;
  /** 0 picks a free port, which is what tests should do. */
  wsPort?: number;
  /** Set false in tests that do not want a UDP listener on a fixed port. */
  discovery?: boolean;
  discoveryPort?: number;
  /** How often to push an unsolicited status frame. */
  statusIntervalMs?: number;
  /** Simulation speed: wall-clock ms per printed layer. */
  msPerLayer?: number;
  /** Files the printer will accept a print command for. */
  files?: string[];
  /**
   * Path to a video to serve as the camera feed. Needs ffmpeg; falls back to
   * synthetic frames if either is missing, so CI stays hermetic.
   */
  videoPath?: string;
  /**
   * What Cmd 386 hands back as the VideoUrl. The real printer returns an RTSP
   * address; by default this fake returns its own MJPEG endpoint instead. Set
   * this to an rtsp:// URL (e.g. a local mediamtx) to exercise the server's
   * RTSP -> MJPEG transcoding path against a genuine RTSP stream.
   */
  videoUrl?: string;
  log?: (msg: string) => void;
}

export interface UploadedFile {
  filename: string;
  size: number;
  md5: string;
}

export interface FakePrinter {
  readonly wsPort: number;
  /** Files uploaded over the HTTP transfer interface during this run. */
  readonly uploads: Map<string, UploadedFile>;
  readonly mainboardId: string;
  readonly state: PrinterState;
  /** Advance the simulation manually; tests use this instead of waiting. */
  tick(deltaMs: number): void;
  /** Push a status frame to every connected client right now. */
  pushStatus(): void;
  close(): Promise<void>;
}

/**
 * A fake Elegoo printer: UDP discovery responder plus an SDCP WebSocket server.
 *
 * It exists so the whole stack runs in CI with no hardware, and so milestones
 * 3-8 can be built before the printer is even switched on. Its payloads come
 * from a fixture (see fixtures.ts) precisely so that a real capture can replace
 * hypothesised shapes without touching this file.
 */
export async function createFakePrinter(options: FakePrinterOptions = {}): Promise<FakePrinter> {
  const fixture = options.fixture ?? MARS_5_ULTRA;
  const statusIntervalMs = options.statusIntervalMs ?? 1000;
  const msPerLayer = options.msPerLayer ?? 300;
  const knownFiles = new Set(options.files ?? ['cthulhu.goo', 'test.goo']);
  const state = new PrinterState(fixture);
  let videoEnabled = true;
  let videoConnections = 0;
  const log = options.log ?? (() => {});
  const frames: FrameSource = await frameSourceFromEnv(options.videoPath, log);
  const mainboardId = fixture.mainboardId;

  const uploads = new Map<string, UploadedFile>();
  // In-flight chunked uploads, keyed by the Uuid the client keeps constant.
  const partials = new Map<string, { filename: string; totalSize: number; received: Buffer }>();

  const http: HttpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // ---- MJPEG camera -----------------------------------------------------
    // A real multipart/x-mixed-replace stream, so the proxy in the server is
    // exercised for real rather than against a hand-rolled fake stream.
    // The frames are not valid JPEGs; the proxy does not decode them.
    if (url.pathname === '/video') {
      if (!videoEnabled) {
        res.writeHead(503).end('video stream disabled');
        return;
      }
      // MaximumVideoStreamAllowed is 1. Refuse a second viewer the way the
      // real printer would, so the proxy's multiplexing is actually required.
      if (videoConnections >= 1) {
        res.writeHead(503).end('maximum video streams reached');
        return;
      }
      videoConnections += 1;
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-store',
      });
      const timer = setInterval(() => {
        const body = frames.next();
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`);
        res.write(body);
        res.write('\r\n');
      }, 250);
      const stop = () => {
        clearInterval(timer);
        videoConnections = Math.max(0, videoConnections - 1);
      };
      req.on('close', stop);
      res.on('close', stop);
      return;
    }

    // ---- File upload ------------------------------------------------------
    // Implements the OFFICIAL spec, not the shape an earlier guess used:
    // multipart/form-data in 1 MB packets carrying Check / Offset / Uuid /
    // TotalSize / File, with the whole-file MD5 in an S-File-MD5 header.
    // Reassembles by offset, because that is what the printer does and it is
    // why offset mismatch has its own error code.
    if (url.pathname === '/uploadFile/upload' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const fail = (code: string, message: string) => {
          // The endpoint answers 200 with success:false for its own errors.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code,
              messages: [{ field: 'File', message }],
              data: null,
              success: false,
            }),
          );
        };

        const raw = Buffer.concat(chunks);
        const contentType = String(req.headers['content-type'] ?? '');
        const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
        const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
        if (!boundary) {
          fail('-4', 'not multipart/form-data');
          return;
        }

        const parts = parseMultipart(raw, boundary);
        const field = (name: string) =>
          parts.find((p) => p.name === name && !p.filename)?.data.toString('utf8');
        const filePart = parts.find((p) => p.name === 'File');

        const offset = Number(field('Offset'));
        const totalSize = Number(field('TotalSize'));
        const uuid = field('Uuid') ?? '';
        const check = field('Check') === '1';
        const claimedMd5 = req.headers['s-file-md5'] as string | undefined;
        const filename = filePart?.filename ?? 'unnamed.goo';

        if (!Number.isInteger(offset) || offset < 0) {
          fail('-1', 'illegal file offset value (less than 0)');
          return;
        }
        if (!filePart) {
          fail('-3', 'no File part in the request');
          return;
        }

        const existing = partials.get(uuid) ?? { filename, totalSize, received: Buffer.alloc(0) };
        // Reassembly is strictly sequential; a gap means the client and the
        // printer disagree about what has been received.
        if (offset !== existing.received.length) {
          fail(
            '-2',
            `file offset does not match the current file (expected ${existing.received.length}, got ${offset})`,
          );
          return;
        }

        existing.filename = filename;
        existing.totalSize = totalSize;
        existing.received = Buffer.concat([existing.received, filePart.data]);
        partials.set(uuid, existing);

        const complete = existing.received.length >= totalSize;
        if (complete) {
          partials.delete(uuid);
          const actual = createHash('md5').update(existing.received).digest('hex');
          if (check && claimedMd5 && claimedMd5 !== actual) {
            // ErrorNumber 1 in PrintInfo is "MD5 Check Failed"; refusing here
            // is the transfer-time equivalent.
            fail('-4', `md5 mismatch (expected ${actual})`);
            return;
          }
          uploads.set(filename, { filename, size: existing.received.length, md5: actual });
          knownFiles.add(filename);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: '000000', messages: null, data: {}, success: true }));
      });
      return;
    }

    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: http, path: '/websocket' });
  const clients = new Set<WebSocket>();

  const broadcast = (payload: unknown) => {
    const text = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  };

  const statusFrame = () => ({
    Id: randomUUID(),
    Topic: topics.status(mainboardId),
    Status: state.snapshot(),
    MainboardID: mainboardId,
    TimeStamp: Math.floor(Date.now() / 1000),
  });

  const attributesFrame = () => ({
    Id: randomUUID(),
    Topic: topics.attributes(mainboardId),
    Attributes: state.attributes(),
    MainboardID: mainboardId,
    TimeStamp: Math.floor(Date.now() / 1000),
  });

  const ackFrame = (requestId: string, cmd: number, ack: number) => ({
    Id: randomUUID(),
    Topic: topics.response(mainboardId),
    Data: {
      Cmd: cmd,
      Data: { Ack: ack },
      RequestID: requestId,
      MainboardID: mainboardId,
      TimeStamp: Math.floor(Date.now() / 1000),
    },
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));

    ws.on('message', (raw) => {
      const text = raw.toString();

      // The heartbeat is a literal string, not a JSON frame.
      if (text === HEARTBEAT_REQUEST) {
        ws.send(HEARTBEAT_RESPONSE);
        return;
      }

      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }

      const data = (frame.Data ?? {}) as Record<string, unknown>;
      const cmd = typeof data.Cmd === 'number' ? data.Cmd : -1;
      const requestId = typeof data.RequestID === 'string' ? data.RequestID : '';
      const payload = (data.Data ?? {}) as Record<string, unknown>;

      switch (cmd) {
        case Cmd.RefreshStatus:
          ws.send(JSON.stringify(ackFrame(requestId, cmd, 0)));
          ws.send(JSON.stringify(statusFrame()));
          return;

        case Cmd.RefreshAttributes:
          ws.send(JSON.stringify(ackFrame(requestId, cmd, 0)));
          ws.send(JSON.stringify(attributesFrame()));
          return;

        case Cmd.StartPrint: {
          const filename = typeof payload.Filename === 'string' ? payload.Filename : '';
          let ack: number = StartPrintAck.Ok;
          if (state.isPrinting) ack = StartPrintAck.Busy;
          else if (!knownFiles.has(filename)) ack = StartPrintAck.NotFound;
          else if (!filename.endsWith('.goo') && !filename.endsWith('.ctb')) {
            ack = StartPrintAck.UnknownFormat;
          }

          ws.send(JSON.stringify(ackFrame(requestId, cmd, ack)));
          if (ack === StartPrintAck.Ok) {
            state.startPrint({
              filename,
              totalLayer: 120,
              msPerLayer,
              taskId: randomUUID(),
            });
            broadcast(statusFrame());
          }
          return;
        }

        case Cmd.Pause:
          state.pause();
          ws.send(JSON.stringify(ackFrame(requestId, cmd, 0)));
          broadcast(statusFrame());
          return;

        case Cmd.Resume:
          state.resume();
          ws.send(JSON.stringify(ackFrame(requestId, cmd, 0)));
          broadcast(statusFrame());
          return;

        case Cmd.Stop:
          state.stop();
          ws.send(JSON.stringify(ackFrame(requestId, cmd, 0)));
          broadcast(statusFrame());
          return;

        case Cmd.ListFiles:
          ws.send(
            JSON.stringify({
              Id: randomUUID(),
              Topic: topics.response(mainboardId),
              Data: {
                Cmd: cmd,
                Data: {
                  Ack: 0,
                  FileList: [...knownFiles].map((name) => ({ name, type: 1 })),
                },
                RequestID: requestId,
                MainboardID: mainboardId,
              },
            }),
          );
          return;

        case Cmd.SetVideoStream: {
          const enable = payload.Enable === 1 || payload.Enable === true;
          // Per the official spec, Cmd 386 answers with a VideoUrl and its own
          // ack codes: 1 exceeded the stream limit, 2 no camera, 3 unknown.
          // The real printer returns an RTSP address; this fake serves MJPEG
          // over HTTP, so it returns that instead and the server consumes
          // whichever it is given.
          if (enable && videoConnections >= MAX_VIDEO_STREAMS) {
            ws.send(JSON.stringify(ackFrame(requestId, cmd, 1)));
            return;
          }
          videoEnabled = enable;
          ws.send(
            JSON.stringify({
              Id: randomUUID(),
              Topic: topics.response(mainboardId),
              Data: {
                Cmd: cmd,
                Data: enable
                  ? { Ack: 0, VideoUrl: options.videoUrl ?? `http://127.0.0.1:${wsPort}/video` }
                  : { Ack: 0 },
                RequestID: requestId,
                MainboardID: mainboardId,
              },
            }),
          );
          return;
        }

        default:
          // Unknown commands are acknowledged rather than ignored, so a client
          // waiting on a RequestID does not hang.
          ws.send(JSON.stringify(ackFrame(requestId, cmd, 0)));
      }
    });
  });

  await new Promise<void>((resolve) => http.listen(options.wsPort ?? 0, '127.0.0.1', resolve));
  const wsPort = (http.address() as AddressInfo).port;

  // ---- UDP discovery ------------------------------------------------------
  let udp: Socket | undefined;
  if (options.discovery !== false) {
    udp = createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('message', (msg, rinfo) => {
      if (msg.toString() !== DISCOVERY_PAYLOAD) return;
      const reply = JSON.stringify({
        Id: randomUUID(),
        Data: { ...fixture.discovery, MainboardIP: '127.0.0.1' },
      });
      udp?.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve) => {
      udp?.bind(options.discoveryPort ?? DISCOVERY_PORT, resolve);
    });
  }

  const statusTimer = setInterval(() => {
    state.tick(statusIntervalMs);
    if (clients.size > 0) broadcast(statusFrame());
  }, statusIntervalMs);
  (statusTimer as unknown as { unref?: () => void }).unref?.();

  return {
    wsPort,
    uploads,
    mainboardId,
    state,
    tick: (deltaMs: number) => state.tick(deltaMs),
    pushStatus: () => broadcast(statusFrame()),
    async close() {
      clearInterval(statusTimer);
      for (const ws of clients) ws.terminate();
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (udp) await new Promise<void>((resolve) => udp?.close(() => resolve()));
    },
  };
}
