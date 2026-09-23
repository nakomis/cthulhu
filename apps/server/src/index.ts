import { buildApp } from './app.js';
import { CameraProxy } from './camera.js';
import { ConfigError, loadConfig } from './config.js';
import { History } from './history.js';
import { type Notifier, nullNotifier, PushoverNotifier } from './notify.js';
import { PrinterService } from './printer.js';
import { openRtspAsMjpeg } from './rtsp.js';
import { PrinterStore } from './store.js';
import { resolveVideoUrl } from './video-url.js';

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const store = new PrinterStore();

  let history: History | undefined;
  try {
    history = new History(config.databasePath);
  } catch (err) {
    // History is a nice-to-have; a missing volume must not stop the server
    // reporting live status, which is the primary job.
    process.stderr.write(`History unavailable (${String(err)}); continuing without it\n`);
  }

  const notifier: Notifier =
    config.pushoverUserKey && config.pushoverAppToken
      ? new PushoverNotifier({
          userKey: config.pushoverUserKey,
          appToken: config.pushoverAppToken,
        })
      : nullNotifier;

  const printer = new PrinterService({
    config,
    store,
    ...(history ? { history } : {}),
    notifier,
    log: (msg) => process.stdout.write(`${msg}\n`),
  });

  // The last RTSP URL the printer handed back, for when its stream counter
  // wedges and it refuses to hand one out again. See video-url.ts.
  let lastVideoUrl: string | undefined;

  const camera = config.cameraEnabled
    ? new CameraProxy({
        // The stream URL comes from Cmd 386, not from configuration: the
        // official spec has the printer hand it back rather than exposing it
        // at a fixed path. CAMERA_URL remains as an override for the fake
        // printer and for a board that turns out to differ.
        openUpstream: async () => {
          const client = printer.client;
          if (!client) throw new Error('Not connected to the printer');

          let url = config.cameraUrl;
          if (url) {
            const address = store.snapshot().address ?? config.printerIp;
            if (!address) throw new Error('No printer address for the camera stream');
            url = url.replace('{ip}', address);
          } else {
            url = await resolveVideoUrl({
              enable: () => client.enableVideo(),
              last: lastVideoUrl,
              address: store.snapshot().address ?? config.printerIp,
              onWarn: (w) => process.stdout.write(`camera: ${w}\n`),
            });
            lastVideoUrl = url;
          }

          // An MJPEG override (the fake printer, or a board that serves it
          // directly) is consumed as-is; anything else goes through ffmpeg.
          if (url.startsWith('http://') || url.startsWith('https://')) {
            const controller = new AbortController();
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok || !res.body) {
              controller.abort();
              throw new Error(`Camera upstream returned ${res.status}`);
            }
            const { Readable } = await import('node:stream');
            return {
              stream: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
              abort: () => controller.abort(),
            };
          }

          return openRtspAsMjpeg({
            url,
            onLog: (line) => process.stdout.write(`${line}\n`),
          });
        },
        onActive: async () => {
          // Only for CAMERA_URL, which bypasses enableVideo(). Otherwise
          // openUpstream enables the stream itself, and enabling it here too
          // sent TWO enables per Watch against one disable: the real printer
          // counts every one, and was full after a single Watch.
          if (config.cameraUrl) await printer.client?.setVideoStream(true).catch(() => {});
        },
        // Release the single slot so the Elegoo app can still connect.
        onIdle: async () => {
          await printer.client?.setVideoStream(false).catch(() => {});
        },
      })
    : undefined;

  const app = buildApp({
    config,
    store,
    printer,
    ...(config.webRoot ? { webRoot: config.webRoot } : {}),
    ...(history ? { history } : {}),
    ...(camera ? { camera } : {}),
    logger: true,
  });

  await app.listen({ port: config.port, host: config.host });

  // Connect after listening, so /health answers even with no printer present.
  printer.start().catch((err: unknown) => {
    process.stderr.write(`Could not connect to the printer: ${String(err)}\n`);
  });

  const shutdown = async () => {
    printer.stop();
    await camera?.close();
    history?.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  process.stderr.write(`Failed to start: ${String(err)}\n`);
  process.exit(1);
});
