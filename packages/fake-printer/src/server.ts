import { randomUUID } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Cmd,
  DISCOVERY_PAYLOAD,
  DISCOVERY_PORT,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  StartPrintAck,
  topics,
} from '@cthulhu/sdcp';
import { type WebSocket, WebSocketServer } from 'ws';
import { MARS_5_ULTRA, type PrinterFixture } from './fixtures.js';
import { PrinterState } from './state.js';

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
}

export interface FakePrinter {
  readonly wsPort: number;
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
  const mainboardId = fixture.mainboardId;

  const http: HttpServer = createServer();
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
