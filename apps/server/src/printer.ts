import { discover, SdcpClient, type SocketLike } from '@cthulhu/sdcp';
import type { Config } from './config.js';
import type { History } from './history.js';
import type { Notifier } from './notify.js';
import type { PrinterStore } from './store.js';

export interface PrinterServiceOptions {
  config: Config;
  store: PrinterStore;
  history?: History;
  notifier?: Notifier;
  /** Injected in tests so no real socket is opened. */
  socketFactory?: (url: string) => SocketLike;
  /** Injected in tests to skip real UDP broadcast. */
  discoverImpl?: typeof discover;
  log?: (msg: string) => void;
}

/**
 * Owns the single connection to the printer and keeps the store fed.
 *
 * Resolution order is deliberate: a pinned PRINTER_IP wins over discovery,
 * because discovery depends on broadcast surviving the network and the pin
 * does not.
 */
export class PrinterService {
  private readonly config: Config;
  private readonly store: PrinterStore;
  private readonly history: History | undefined;
  private readonly notifier: Notifier | undefined;
  private readonly socketFactory: ((url: string) => SocketLike) | undefined;
  private readonly discoverImpl: typeof discover;
  private readonly log: (msg: string) => void;

  client: SdcpClient | undefined;

  constructor(options: PrinterServiceOptions) {
    this.config = options.config;
    this.store = options.store;
    this.history = options.history;
    this.notifier = options.notifier;
    this.socketFactory = options.socketFactory;
    this.discoverImpl = options.discoverImpl ?? discover;
    this.log = options.log ?? (() => {});
  }

  /** Find the printer: pinned IP first, then discovery. */
  async resolve(): Promise<{ address: string; mainboardId: string } | undefined> {
    if (this.config.printerIp) {
      // A pinned IP has no mainboard id until attributes come back, but the
      // id is only needed in the request envelope, and the printer accepts a
      // refresh that lets us learn it. Discovery is still tried to fill it in.
      const discovered = await this.tryDiscover();
      const match = discovered.find((p) => p.address === this.config.printerIp);
      return {
        address: this.config.printerIp,
        mainboardId: match?.mainboardId ?? '',
      };
    }

    const found = await this.tryDiscover();
    const first = found[0];
    if (!first) return undefined;
    return { address: first.address, mainboardId: first.mainboardId };
  }

  private async tryDiscover(): Promise<Awaited<ReturnType<typeof discover>>> {
    if (!this.config.discoveryEnabled) return [];
    try {
      return await this.discoverImpl({
        timeoutMs: this.config.discoveryTimeoutMs,
        broadcastAddress: this.config.discoveryBroadcastAddress,
      });
    } catch (err) {
      // Discovery failing is normal in a bridged container; it must not be
      // fatal when a pinned IP is available.
      this.log(`discovery failed: ${String(err)}`);
      return [];
    }
  }

  async start(): Promise<void> {
    const target = await this.resolve();
    if (!target) {
      this.log('no printer found; will not connect');
      this.store.setConnection(false);
      return;
    }

    const client = new SdcpClient({
      address: target.address,
      mainboardId: target.mainboardId,
      ...(this.socketFactory ? { socketFactory: this.socketFactory } : {}),
    });
    this.client = client;

    client.on('status', (status) => {
      this.store.applyStatus(status);
    });
    client.on('attributes', (attrs) => {
      this.store.applyAttributes(attrs);
      // The client adopts the mainboard id from attributes when it started
      // empty (pinned IP, discovery off). Push it through to the store too,
      // or /api/status keeps reporting the empty string it connected with.
      if (client.mainboardId) {
        this.store.setConnection(true, target.address, client.mainboardId);
      }
    });
    client.on('open', () => {
      this.store.setConnection(true, target.address, target.mainboardId);
      void client.refreshAttributes().catch(() => {});
      void client.refreshStatus().catch(() => {});
    });
    client.on('close', () => {
      this.store.setConnection(false);
    });
    client.on('error', (err) => {
      this.log(`printer error: ${err.message}`);
    });

    this.store.on('printStarted', ({ filename, taskId, totalLayer }) => {
      this.history?.startPrint(taskId, filename, totalLayer);
    });

    this.store.on('printFinished', ({ filename, taskId }) => {
      this.history?.finishPrint(taskId, 'complete');
      // notify() never throws and returns false on failure - which, unlogged,
      // means a broken notification path is indistinguishable from a working
      // one until somebody notices their phone never buzzes. Say something.
      void this.notifier
        ?.notify(
          'Print finished',
          filename ? `${filename} has finished printing.` : 'The print has finished.',
        )
        .then((sent) => {
          this.log(
            sent
              ? `notified: ${filename ?? 'print'} finished`
              : `NOTIFICATION FAILED for ${filename ?? 'print'} - check PUSHOVER_* and connectivity`,
          );
        });
    });

    await client.connect();
  }

  stop(): void {
    this.client?.close();
    this.client = undefined;
  }
}
