import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  Cmd,
  type CmdValue,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  START_PRINT_ACK_MESSAGES,
  StartPrintAck,
  topics,
  WEBSOCKET_PORT,
} from './protocol.js';
import {
  type PrinterAttributes,
  type PrinterStatus,
  parseAttributes,
  parseStatus,
} from './status.js';

/**
 * Minimal structural type for a WebSocket, so this package does not depend on
 * a particular implementation. Node 25's global WebSocket and `ws` both fit.
 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'close', cb: () => void): void;
  addEventListener(type: 'error', cb: (ev: unknown) => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface SdcpClientOptions {
  address: string;
  mainboardId: string;
  port?: number;
  path?: string;
  /** Heartbeat period. The printer expects a literal "ping", not a WS frame. */
  heartbeatMs?: number;
  /** Time to wait for a command acknowledgement before rejecting. */
  requestTimeoutMs?: number;
  /** Reconnect backoff bounds. */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Injected so tests can drive the client without a real socket. */
  socketFactory?: SocketFactory;
}

export class SdcpError extends Error {}

export class StartPrintError extends SdcpError {
  // Declared and assigned rather than a constructor parameter property:
  // `erasableSyntaxOnly` forbids those, because they emit real code.
  readonly ack: number;

  constructor(ack: number) {
    super(`Start print refused: ${START_PRINT_ACK_MESSAGES[ack] ?? `unknown ack ${ack}`} (${ack})`);
    this.ack = ack;
  }
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SdcpClientEvents {
  status: [PrinterStatus];
  attributes: [PrinterAttributes];
  error: [Error];
  notice: [Record<string, unknown>];
  open: [];
  close: [];
}

/**
 * SDCP client over the printer's WebSocket control channel.
 *
 * Handles the transport - connecting, the literal ping/pong heartbeat,
 * correlating responses to requests by RequestID, and reconnecting with
 * backoff. The transport is the part of the community documentation most
 * likely to be correct; the payload shapes are not. See status.ts.
 */
export class SdcpClient extends EventEmitter<SdcpClientEvents> {
  readonly address: string;
  /**
   * Not readonly: with a pinned PRINTER_IP and discovery disabled there is no
   * way to know the mainboard id up front, so it starts empty and is adopted
   * from the first attributes message. Every request envelope carries it, and
   * a real printer is unlikely to be as forgiving about an empty one as the
   * fake is.
   */
  mainboardId: string;
  private readonly port: number;
  private readonly path: string;
  private readonly heartbeatMs: number;
  private readonly requestTimeoutMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly socketFactory: SocketFactory;

  private socket: SocketLike | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelay: number;
  private closedByUser = false;
  private readonly pending = new Map<string, Pending>();

  lastStatus: PrinterStatus | undefined;
  lastAttributes: PrinterAttributes | undefined;

  constructor(options: SdcpClientOptions) {
    super();
    this.address = options.address;
    this.mainboardId = options.mainboardId;
    this.port = options.port ?? WEBSOCKET_PORT;
    this.path = options.path ?? '/websocket';
    this.heartbeatMs = options.heartbeatMs ?? 5000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.reconnectMinMs = options.reconnectMinMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.reconnectDelay = this.reconnectMinMs;
    this.socketFactory =
      options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  }

  get url(): string {
    return `ws://${this.address}:${this.port}${this.path}`;
  }

  get connected(): boolean {
    return this.socket !== undefined;
  }

  connect(): Promise<void> {
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = this.socketFactory(this.url);
      this.socket = socket;

      socket.addEventListener('open', () => {
        this.reconnectDelay = this.reconnectMinMs;
        this.startHeartbeat();
        this.emit('open');
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.addEventListener('message', (ev) => {
        this.handleMessage(ev.data);
      });

      socket.addEventListener('error', (ev) => {
        const err = new SdcpError(`WebSocket error from ${this.url}: ${describe(ev)}`);
        this.emit('error', err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      socket.addEventListener('close', () => {
        this.teardownSocket();
        this.emit('close');
        if (!settled) {
          settled = true;
          reject(new SdcpError(`WebSocket to ${this.url} closed before opening`));
        }
        this.scheduleReconnect();
      });
    });
  }

  /** Close and stop reconnecting. */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.teardownSocket();
    socket?.close();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new SdcpError('Client closed'));
      this.pending.delete(id);
    }
  }

  private teardownSocket(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.socket = undefined;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      // A literal string, NOT a JSON frame and NOT a WebSocket ping frame.
      try {
        this.socket?.send(HEARTBEAT_REQUEST);
      } catch {
        // The close handler deals with a dead socket.
      }
    }, this.heartbeatMs);
    // Do not hold the event loop open just for the heartbeat.
    (this.heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectMaxMs, this.reconnectDelay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch(() => {
        // connect() emits 'error'; the close handler schedules the next go.
      });
    }, delay);
    (this.reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  private handleMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : String(data);
    if (text === HEARTBEAT_RESPONSE || text === HEARTBEAT_REQUEST) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.emit('error', new SdcpError(`Unparseable frame: ${text.slice(0, 200)}`));
      return;
    }

    const frame = parsed as Record<string, unknown>;
    const topic = typeof frame.Topic === 'string' ? frame.Topic : '';

    if (topic.startsWith('sdcp/response/')) {
      this.resolvePending(frame);
      return;
    }
    if (topic.startsWith('sdcp/status/')) {
      const status = parseStatus(frame);
      this.lastStatus = status;
      this.emit('status', status);
      return;
    }
    if (topic.startsWith('sdcp/attributes/')) {
      const attributes = parseAttributes(frame);
      this.lastAttributes = attributes;
      if (!this.mainboardId && attributes.mainboardId) {
        this.mainboardId = attributes.mainboardId;
      }
      this.emit('attributes', attributes);
      return;
    }
    if (topic.startsWith('sdcp/error/')) {
      this.emit('error', new SdcpError(`Printer error: ${text.slice(0, 300)}`));
      return;
    }
    if (topic.startsWith('sdcp/notice/')) {
      this.emit('notice', frame);
    }
  }

  private resolvePending(frame: Record<string, unknown>): void {
    const data = (frame.Data ?? {}) as Record<string, unknown>;
    const requestId = typeof data.RequestID === 'string' ? data.RequestID : undefined;
    if (!requestId) return;
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(data);
  }

  /** Send a command and wait for its acknowledgement. */
  send<T extends Record<string, unknown>>(
    cmd: CmdValue,
    data: T = {} as T,
  ): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new SdcpError('Not connected'));

    const requestId = randomUUID();
    const envelope = {
      Id: randomUUID(),
      Topic: topics.request(this.mainboardId),
      Data: {
        Cmd: cmd,
        Data: data,
        RequestID: requestId,
        MainboardID: this.mainboardId,
        TimeStamp: Math.floor(Date.now() / 1000),
        From: 0,
      },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new SdcpError(`Timed out waiting for ack to Cmd ${cmd}`));
      }, this.requestTimeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();

      this.pending.set(requestId, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(envelope));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new SdcpError(`Failed to send Cmd ${cmd}: ${String(err)}`));
      }
    });
  }

  refreshStatus(): Promise<Record<string, unknown>> {
    return this.send(Cmd.RefreshStatus);
  }

  refreshAttributes(): Promise<Record<string, unknown>> {
    return this.send(Cmd.RefreshAttributes);
  }

  pause(): Promise<Record<string, unknown>> {
    return this.send(Cmd.Pause);
  }

  resume(): Promise<Record<string, unknown>> {
    return this.send(Cmd.Resume);
  }

  /** Abandons the print. The UI must confirm before calling this. */
  stop(): Promise<Record<string, unknown>> {
    return this.send(Cmd.Stop);
  }

  listFiles(url = '/local'): Promise<Record<string, unknown>> {
    return this.send(Cmd.ListFiles, { Url: url });
  }

  historyTaskList(): Promise<Record<string, unknown>> {
    return this.send(Cmd.HistoryTaskList);
  }

  historyTaskDetail(taskIds: string[]): Promise<Record<string, unknown>> {
    return this.send(Cmd.HistoryTaskDetail, { Id: taskIds });
  }

  setVideoStream(enable: boolean): Promise<Record<string, unknown>> {
    return this.send(Cmd.SetVideoStream, { Enable: enable ? 1 : 0 });
  }

  setTimeLapse(enable: boolean): Promise<Record<string, unknown>> {
    return this.send(Cmd.SetTimeLapse, { Enable: enable ? 1 : 0 });
  }

  /** Throws StartPrintError on any non-zero ack, so callers see a real reason. */
  async startPrint(filename: string, startLayer = 0): Promise<void> {
    const ack = await this.send(Cmd.StartPrint, { Filename: filename, StartLayer: startLayer });
    const code =
      typeof ack.Data === 'object' && ack.Data !== null
        ? (ack.Data as Record<string, unknown>).Ack
        : ack.Ack;
    const value = typeof code === 'number' ? code : StartPrintAck.Ok;
    if (value !== StartPrintAck.Ok) throw new StartPrintError(value);
  }
}

function describe(ev: unknown): string {
  if (ev instanceof Error) return ev.message;
  if (typeof ev === 'object' && ev !== null && 'message' in ev) {
    return String((ev as { message: unknown }).message);
  }
  return 'unknown';
}
