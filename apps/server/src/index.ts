import { buildApp } from './app.js';
import { CameraProxy } from './camera.js';
import { ConfigError, loadConfig } from './config.js';
import { History } from './history.js';
import { type Notifier, nullNotifier, PushoverNotifier } from './notify.js';
import { PrinterService } from './printer.js';
import { PrinterStore } from './store.js';

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

  const camera = config.cameraEnabled
    ? new CameraProxy({
        openUpstream: async () => {
          const address = store.snapshot().address ?? config.printerIp;
          if (!address) throw new Error('No printer address for the camera stream');
          const url = config.cameraUrl.replace('{ip}', address);
          // The controller is the only thing that actually closes the
          // connection; destroying the Readable does not.
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
        },
        onActive: async () => {
          await printer.client?.setVideoStream(true).catch(() => {});
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
