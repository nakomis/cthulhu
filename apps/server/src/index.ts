import { dirname, join } from 'node:path';
import { CameraProxy, openRtspAsMjpeg } from '@cthulhu/camera';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { FileMetaCache } from './file-meta.js';
import { createHistoryStore, type HistoryStore } from './history.js';
import { type Notifier, nullNotifier, PushoverNotifier } from './notify.js';
import { PrintView } from './print-view.js';
import { PrinterService } from './printer.js';
import { PrinterStore } from './store.js';
import { cameraServiceOrigin, TimelapseRecorder } from './timelapse.js';
import { TimelapseArchiver } from './timelapse-archive.js';
import { VideoLease } from './video-lease.js';
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

  let history: HistoryStore | undefined;
  try {
    history = await createHistoryStore(config);
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

  // One enable for the first user of the printer's stream, one disable after
  // the last: browsers and the time-lapse share it. See video-lease.ts.
  const videoLease = new VideoLease((on) =>
    printer.client ? printer.client.setVideoStream(on) : Promise.resolve(),
  );

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
          if (config.cameraUrl) await videoLease.acquire();
        },
        // Release the slot so the Elegoo app can still connect - through the
        // lease, so a time-lapse still recording keeps the stream on.
        onIdle: async () => {
          if (config.cameraUrl) await videoLease.release();
          else await printer.client?.setVideoStream(false).catch(() => {});
        },
      })
    : undefined;

  // Beside the database, on the same volume. Both are caches: not in the
  // nightly backup (which copies only the SQLite file), and rebuilt from the
  // printer when missing.
  const dataDir = dirname(config.databasePath);
  const fileMeta = new FileMetaCache({ dir: join(dataDir, 'file-meta'), port: config.uploadPort });
  const printView = new PrintView({
    dir: join(dataDir, 'print-files'),
    port: config.uploadPort,
    log: (line) => process.stdout.write(`${line}\n`),
    detail: async (taskId) => {
      const res = await printer.client?.historyTaskDetail([taskId]);
      const data = (res?.Data ?? res) as
        | { HistoryDetailList?: Record<string, unknown>[] }
        | undefined;
      const task = data?.HistoryDetailList?.[0];
      if (!task || typeof task.TaskName !== 'string') return undefined;
      return {
        taskName: task.TaskName,
        thumbnailUrl: typeof task.Thumbnail === 'string' ? task.Thumbnail : undefined,
      };
    },
  });
  // A time-lapse of every print, made by the camera service. Only when the
  // camera IS that service: transcoding on Luke is the fallback, not the plan.
  const timelapseBase = config.cameraEnabled ? cameraServiceOrigin(config.cameraUrl) : undefined;
  const timelapse = timelapseBase
    ? new TimelapseRecorder({
        baseUrl: timelapseBase,
        lease: videoLease,
        log: (line) => process.stdout.write(`${line}\n`),
      })
    : undefined;
  if (timelapse) store.on('update', (view) => timelapse.update(view));

  // Finished time-lapses moved off the camera service and onto the share -
  // only once there is somewhere to put them AND a camera service to fetch
  // them from. See CTHU-16.
  const timelapseArchiver =
    config.timelapseArchiveDir && timelapseBase
      ? new TimelapseArchiver({
          baseUrl: timelapseBase,
          dir: config.timelapseArchiveDir,
          ...(history ? { history } : {}),
          log: (line) => process.stdout.write(`${line}\n`),
        })
      : undefined;
  if (timelapseArchiver) {
    timelapseArchiver.start();
    // Promptly after a print finishes, rather than waiting up to 60s.
    store.on('printFinished', () => void timelapseArchiver.tick());
  }

  // Fetch the print file as soon as a print starts, so the first layer image
  // is not a 45-second wait.
  store.on('printStarted', ({ taskId }) => {
    const address = store.snapshot().address ?? config.printerIp;
    if (taskId && address) void printView.prepare(address, taskId);
  });

  const app = buildApp({
    config,
    store,
    printer,
    ...(config.webRoot ? { webRoot: config.webRoot } : {}),
    ...(history ? { history } : {}),
    ...(camera ? { camera } : {}),
    fileMeta,
    printView,
    ...(timelapseBase ? { timelapseBase } : {}),
    ...(timelapseArchiver ? { timelapseArchiver } : {}),
    logger: true,
  });

  await app.listen({ port: config.port, host: config.host });

  // Connect after listening, so /health answers even with no printer present.
  printer.start().catch((err: unknown) => {
    process.stderr.write(`Could not connect to the printer: ${String(err)}\n`);
  });

  const shutdown = async () => {
    printer.stop();
    timelapseArchiver?.stop();
    await camera?.close();
    await history?.close();
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
