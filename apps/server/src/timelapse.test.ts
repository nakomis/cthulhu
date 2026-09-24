import { PrintStatus } from '@cthulhu/sdcp';
import { describe, expect, it, vi } from 'vitest';
import type { PrinterView } from './store.js';
import { cameraServiceOrigin, TimelapseRecorder } from './timelapse.js';
import { VideoLease } from './video-lease.js';

const view = (taskId: string | undefined, status: number, currentLayer = 0): PrinterView =>
  ({ print: { taskId, status, currentLayer } }) as unknown as PrinterView;

function recorder() {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url.replace('http://phi:9121', ''));
    return new Response('{}');
  });
  const setStream = vi.fn(async () => {});
  const lease = new VideoLease(setStream);
  const r = new TimelapseRecorder({
    baseUrl: 'http://phi:9121',
    lease,
    fetchImpl: fetchImpl as never,
  });
  const settle = () => new Promise((res) => setTimeout(res, 0));
  return { r, calls, setStream, lease, settle };
}

describe('TimelapseRecorder', () => {
  it('takes a frame at the top of every lift, then assembles at the end', async () => {
    const { r, calls, settle } = recorder();
    const { Homing, Dropping, Exposuring, Lifting, Stopping, Complete } = PrintStatus;
    for (const [status, layer] of [
      [Homing, 0],
      [Exposuring, 0],
      [Lifting, 0],
      [Dropping, 1],
      [Exposuring, 1],
      [Lifting, 1],
      [Dropping, 2],
      [Exposuring, 2],
      [Lifting, 2],
      [Stopping, 3],
      [Complete, 3],
    ] as const) {
      r.update(view('t1', status, layer));
    }
    await settle();
    expect(calls).toEqual([
      '/timelapse/t1/start',
      '/timelapse/t1/frame?layer=1',
      '/timelapse/t1/frame?layer=2',
      // The last lift ends in Stopping: that frame is the finished model.
      '/timelapse/t1/frame?layer=3',
      '/timelapse/t1/finish',
    ]);
  });

  it('picks a print back up after a restart, mid-print', async () => {
    const { r, calls, settle } = recorder();
    r.update(view('t2', PrintStatus.Lifting, 400));
    r.update(view('t2', PrintStatus.Dropping, 401));
    await settle();
    expect(calls).toEqual(['/timelapse/t2/start', '/timelapse/t2/frame?layer=401']);
  });

  it('keeps recording through a pause', async () => {
    const { r, calls, settle } = recorder();
    r.update(view('t3', PrintStatus.Exposuring, 5));
    r.update(view('t3', PrintStatus.Paused, 5));
    r.update(view('t3', PrintStatus.Exposuring, 5));
    await settle();
    expect(calls).toEqual(['/timelapse/t3/start']);
  });

  it('holds the printer stream for the whole print, through the lease', async () => {
    const { r, setStream, lease, settle } = recorder();
    r.update(view('t4', PrintStatus.Homing));
    await settle();
    expect(setStream).toHaveBeenLastCalledWith(true);

    // A browser comes and goes: the stream must stay on for the time-lapse.
    await lease.acquire();
    await lease.release();
    expect(setStream).toHaveBeenCalledTimes(1);

    r.update(view('t4', PrintStatus.Complete));
    await settle();
    await settle();
    expect(setStream).toHaveBeenLastCalledWith(false);
    expect(lease.count).toBe(0);
  });
});

describe('VideoLease', () => {
  it('enables once for the first holder and disables once after the last', async () => {
    const setStream = vi.fn(async () => {});
    const lease = new VideoLease(setStream);
    await lease.acquire();
    await lease.acquire();
    await lease.release();
    await lease.release();
    await lease.release(); // one too many: ignored, not a stray disable
    expect(setStream.mock.calls).toEqual([[true], [false]]);
  });
});

describe('cameraServiceOrigin', () => {
  it('is the camera service when CAMERA_URL points at one', () => {
    expect(cameraServiceOrigin('http://172.29.0.14:9121/video')).toBe('http://172.29.0.14:9121');
    expect(cameraServiceOrigin('')).toBeUndefined();
    expect(cameraServiceOrigin('rtsp://printer/video')).toBeUndefined();
    // The fake printer's template form is not a camera service.
    expect(cameraServiceOrigin('http://{ip}:3031/video')).toBeUndefined();
  });
});
