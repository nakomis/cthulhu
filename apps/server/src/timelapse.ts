import { PrintStatus } from '@cthulhu/sdcp';
import type { PrinterView } from './store.js';
import type { VideoLease } from './video-lease.js';

export interface TimelapseRecorderOptions {
  /** The camera service: http://phi:9121 - its /timelapse routes. */
  baseUrl: string;
  lease?: VideoLease;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** Still a print: running, pausing or paused. */
const printing = (s: number | undefined) =>
  s !== undefined && s >= PrintStatus.Homing && s <= PrintStatus.Paused;

/**
 * A time-lapse of every print: one frame at the top of each layer.
 *
 * Watches status and tells the camera service when to act; the frames and
 * the video are made there, off Luke. On the real printer a layer goes
 * Exposing (~3.1 s), Lifting (~2.3 s), Dropping (~2.0 s): the moment Lifting
 * gives way to Dropping, the plate is at the top of its lift with the model
 * clear of the resin. The last lift ends in Stopping rather than Dropping,
 * and is taken too - it is the finished model.
 */
export class TimelapseRecorder {
  private readonly options: TimelapseRecorderOptions;
  private readonly fetchImpl: typeof fetch;
  private current: string | undefined;
  private lastStatus: number | undefined;

  constructor(options: TimelapseRecorderOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get recording(): string | undefined {
    return this.current;
  }

  /** Feed every status update. Fire-and-forget: nothing here blocks status. */
  update(view: PrinterView): void {
    const { taskId, status, currentLayer } = view.print;
    const previous = this.lastStatus;
    this.lastStatus = status;

    if (this.current && (taskId !== this.current || !printing(status))) {
      // The last lift before the end: the finished model, clear of the resin.
      if (taskId === this.current && previous === PrintStatus.Lifting) {
        void this.post(`/timelapse/${this.current}/frame?layer=${currentLayer ?? 0}`);
      }
      this.finish(this.current);
    }
    // Also after a restart mid-print: the camera service carries on from disk.
    if (taskId && printing(status) && taskId !== this.current) this.start(taskId);

    if (
      this.current &&
      taskId === this.current &&
      previous === PrintStatus.Lifting &&
      status === PrintStatus.Dropping
    ) {
      void this.post(`/timelapse/${taskId}/frame?layer=${currentLayer ?? 0}`);
    }
  }

  private start(taskId: string): void {
    this.current = taskId;
    this.options.log?.(`time-lapse ${taskId}: recording`);
    void this.options.lease?.acquire();
    void this.post(`/timelapse/${taskId}/start`);
  }

  private finish(taskId: string): void {
    this.current = undefined;
    this.options.log?.(`time-lapse ${taskId}: finishing`);
    void this.post(`/timelapse/${taskId}/finish`).finally(() => this.options.lease?.release());
  }

  private async post(path: string): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.options.baseUrl}${path}`, { method: 'POST' });
      // 409 is "no fresh frame" - the camera is still starting. One layer
      // missing from a time-lapse is not worth a log line per layer.
      if (!res.ok && res.status !== 409) {
        this.options.log?.(`time-lapse: ${path} answered ${res.status}`);
      }
    } catch (err) {
      this.options.log?.(`time-lapse: ${path} failed: ${String(err)}`);
    }
  }
}

/** The camera service's origin, from CAMERA_URL - or undefined if it is not one. */
export function cameraServiceOrigin(cameraUrl: string): string | undefined {
  if (!/^https?:\/\//.test(cameraUrl) || cameraUrl.includes('{ip}')) return undefined;
  try {
    return new URL(cameraUrl).origin;
  } catch {
    return undefined;
  }
}
