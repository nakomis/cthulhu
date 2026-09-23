#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SdcpClient } from './client.js';
import { discover } from './discovery.js';

/**
 * `cthulhu-sdcp` — talk to a real printer from a terminal.
 *
 * This is the acceptance criterion for CTHU-2 ("a CLI prints live status from
 * the real printer"), but its more important job is `--record`: capturing what
 * the Mars 5 Ultra ACTUALLY sends, before anybody writes a parser against
 * documentation that describes a different class of machine.
 *
 *   cthulhu-sdcp discover
 *   cthulhu-sdcp status  [--ip 172.29.0.x] [--port 3030] [--record capture.jsonl]
 *   cthulhu-sdcp watch   [--ip 172.29.0.x] [--port 3030] [--record capture.jsonl]
 *
 * --record writes one JSON object per line: every frame, verbatim and
 * untouched, with a receive timestamp. That file is the fixture the fake
 * printer replays, so recording a whole print gives the test suite a real
 * SLA machine to imitate.
 */

interface Args {
  command: string;
  ip: string | undefined;
  /** Override the WebSocket port. The real printer is 3030; the fake printer
   *  binds an ephemeral port in tests, so this is how they meet. */
  port: number | undefined;
  record: string | undefined;
  timeoutMs: number;
  raw: boolean;
}

function parseArgs(argv: string[]): Args {
  const [command = 'status', ...rest] = argv;
  const args: Args = {
    command,
    ip: undefined,
    port: undefined,
    record: undefined,
    timeoutMs: 3000,
    raw: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    switch (flag) {
      case '--ip':
        args.ip = value;
        i += 1;
        break;
      case '--port':
        args.port = Number(value) || undefined;
        i += 1;
        break;
      case '--record':
        args.record = value;
        i += 1;
        break;
      case '--timeout':
        args.timeoutMs = Number(value) || args.timeoutMs;
        i += 1;
        break;
      case '--raw':
        args.raw = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Append one frame to the capture, verbatim. */
function makeRecorder(path: string | undefined): (kind: string, frame: unknown) => void {
  if (!path) return () => {};
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '', { flag: 'a' });
  out(`recording to ${path}`);
  return (kind, frame) => {
    // JSON Lines: append-only, survives a kill mid-print, and each line is
    // independently parseable - which matters when the interesting thing is
    // a print that ran for three hours.
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), kind, frame })}\n`);
  };
}

async function resolveTarget(args: Args): Promise<{ address: string; mainboardId: string }> {
  if (args.ip) {
    // A pinned IP has no mainboard id until attributes arrive; the client
    // adopts it from the first attributes message.
    return { address: args.ip, mainboardId: '' };
  }
  out('discovering (UDP broadcast on port 3000)...');
  const found = await discover({ timeoutMs: args.timeoutMs });
  const first = found[0];
  if (!first) {
    throw new Error(
      'No printer found. Broadcast does not cross subnets and Docker bridge networking eats it; ' +
        'try --ip <address>.',
    );
  }
  return { address: first.address, mainboardId: first.mainboardId };
}

function describeStatus(s: import('./status.js').PrinterStatus): string {
  const p = s.printInfo;
  const parts = [
    `status=${p.status ?? '?'}`,
    `layer=${p.currentLayer ?? '?'}/${p.totalLayer ?? '?'}`,
    p.filename ? `file=${p.filename}` : '',
    s.devicesStatus.releaseFilmState !== undefined
      ? `film=${s.devicesStatus.releaseFilmState}`
      : '',
  ].filter(Boolean);
  return parts.join('  ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'discover') {
    const found = await discover({ timeoutMs: args.timeoutMs });
    if (found.length === 0) {
      out('no printers answered');
      process.exitCode = 1;
      return;
    }
    for (const p of found) {
      out(`${p.address}  ${p.machineName || p.name}  mainboard=${p.mainboardId}`);
      out(`    firmware=${p.firmwareVersion}  protocol=${p.protocolVersion}`);
    }
    return;
  }

  const record = makeRecorder(args.record);
  const target = await resolveTarget(args);
  out(`connecting to ${target.address}`);

  const client = new SdcpClient({
    address: target.address,
    mainboardId: target.mainboardId,
    ...(args.port ? { port: args.port } : {}),
  });

  client.on('status', (s) => {
    record('status', s.raw);
    out(args.raw ? JSON.stringify(s.raw) : describeStatus(s));
  });
  client.on('attributes', (a) => {
    record('attributes', a.raw);
    out(args.raw ? JSON.stringify(a.raw) : `attributes: ${a.machineName ?? '?'}`);
  });
  client.on('error', (e) => process.stderr.write(`error: ${e.message}\n`));

  await client.connect();
  await client.refreshAttributes();
  await client.refreshStatus();

  if (args.command === 'status') {
    // Give the pushed frames a moment to arrive, then stop.
    await new Promise((r) => setTimeout(r, 1500));
    client.close();
    return;
  }

  // watch: stay connected until interrupted. This is the mode for capturing a
  // whole print.
  out('watching — Ctrl-C to stop');
  process.on('SIGINT', () => {
    client.close();
    process.exit(0);
  });
  await new Promise(() => {});
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
