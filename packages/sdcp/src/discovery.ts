import { createSocket } from 'node:dgram';
import {
  DISCOVERY_PAYLOAD,
  DISCOVERY_PORT,
  type DiscoveredPrinter,
  type DiscoveryResponse,
} from './protocol.js';

export interface DiscoverOptions {
  /** How long to listen for replies. Printers answer well within a second. */
  timeoutMs?: number;
  /** Broadcast address. Override when the subnet is not the default. */
  broadcastAddress?: string;
}

/** Narrow an arbitrary JSON value to a DiscoveryResponse without trusting it. */
export function parseDiscoveryResponse(raw: unknown): DiscoveredPrinter | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const outer = raw as Partial<DiscoveryResponse>;
  const data = outer.Data;
  if (typeof outer.Id !== 'string' || typeof data !== 'object' || data === null) return null;
  if (typeof data.MainboardIP !== 'string' || typeof data.MainboardID !== 'string') return null;
  return {
    id: outer.Id,
    name: data.Name ?? '',
    machineName: data.MachineName ?? '',
    brandName: data.BrandName ?? '',
    address: data.MainboardIP,
    mainboardId: data.MainboardID,
    protocolVersion: data.ProtocolVersion ?? '',
    firmwareVersion: data.FirmwareVersion ?? '',
  };
}

/**
 * Broadcast on the LAN and collect every printer that answers.
 *
 * UDP broadcast does not cross subnets, and Docker's bridge networking eats it
 * entirely - the container needs host networking for this to work at all. A
 * pinned PRINTER_IP is the supported fallback, and in production is the more
 * reliable option anyway. See CTHU-10.
 */
export async function discover(options: DiscoverOptions = {}): Promise<DiscoveredPrinter[]> {
  const { timeoutMs = 2000, broadcastAddress = '255.255.255.255' } = options;
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  const found = new Map<string, DiscoveredPrinter>();

  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      socket.close();
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });

    socket.on('message', (msg) => {
      try {
        const printer = parseDiscoveryResponse(JSON.parse(msg.toString('utf8')));
        // Key on mainboard id so a printer answering twice appears once.
        if (printer) found.set(printer.mainboardId, printer);
      } catch {
        // A malformed reply is not worth failing the whole scan over.
      }
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(DISCOVERY_PAYLOAD, DISCOVERY_PORT, broadcastAddress, (err) => {
        if (err) {
          clearTimeout(timer);
          socket.close();
          reject(err);
        }
      });
    });
  });
}
