#!/usr/bin/env node
import { createFakePrinter } from './server.js';

/**
 * Run the fake printer as a standalone process, so the real server and the
 * real dashboard can be developed against it with no hardware.
 *
 *   pnpm --filter @cthulhu/fake-printer start
 *
 * Environment:
 *   FAKE_WS_PORT        WebSocket/HTTP port           (default 3030, the real one)
 *   FAKE_DISCOVERY      answer UDP broadcasts         (default true)
 *   FAKE_MS_PER_LAYER   simulation speed              (default 2000)
 *   FAKE_TOTAL_LAYERS   layers in a simulated print   (default 120)
 *   FAKE_AUTOSTART      begin a print immediately     (default false)
 *   FAKE_VIDEO          path to an mp4 for the camera (needs ffmpeg)
 *   FAKE_VIDEO_URL      VideoUrl returned by Cmd 386, e.g. an rtsp:// stream
 */
async function main(): Promise<void> {
  const wsPort = Number(process.env.FAKE_WS_PORT ?? 3030);
  const discovery = process.env.FAKE_DISCOVERY !== 'false';
  const msPerLayer = Number(process.env.FAKE_MS_PER_LAYER ?? 2000);
  const autostart = process.env.FAKE_AUTOSTART === 'true';

  const printer = await createFakePrinter({
    wsPort,
    discovery,
    msPerLayer,
    statusIntervalMs: 1000,
    ...(process.env.FAKE_VIDEO ? { videoPath: process.env.FAKE_VIDEO } : {}),
    ...(process.env.FAKE_VIDEO_URL ? { videoUrl: process.env.FAKE_VIDEO_URL } : {}),
    log: (msg) => process.stdout.write(`  ${msg}\n`),
  });

  process.stdout.write(
    [
      'Fake Elegoo Mars 5 Ultra',
      `  websocket   ws://127.0.0.1:${printer.wsPort}/websocket`,
      `  camera      http://127.0.0.1:${printer.wsPort}/video`,
      `  upload      POST http://127.0.0.1:${printer.wsPort}/uploadFile/upload`,
      `  mainboard   ${printer.mainboardId}`,
      `  discovery   ${discovery ? 'UDP 3000, answering M99999' : 'disabled'}`,
      `  speed       ${msPerLayer}ms per layer`,
      '',
      'Point the server at it with:',
      `  PRINTER_IP=127.0.0.1 DISCOVERY_ENABLED=false pnpm --filter @cthulhu/server dev`,
      '',
    ].join('\n'),
  );

  if (autostart) {
    printer.state.startPrint({
      filename: 'cthulhu.goo',
      totalLayer: Number(process.env.FAKE_TOTAL_LAYERS ?? 120),
      msPerLayer,
      taskId: 'autostart',
    });
    process.stdout.write('Auto-started a print.\n');
  }

  const shutdown = async () => {
    await printer.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  process.stderr.write(`Fake printer failed to start: ${String(err)}\n`);
  process.exit(1);
});
