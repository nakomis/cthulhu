import { VideoAck, VideoStreamError } from '@cthulhu/sdcp';
import { describe, expect, it } from 'vitest';
import { resolveVideoUrl } from './video-url.js';

const refuse = (ack: number) => async () => {
  throw new VideoStreamError(ack);
};

describe('resolveVideoUrl', () => {
  it('uses the URL the printer hands back', async () => {
    const url = await resolveVideoUrl({
      enable: async () => 'rtsp://172.29.0.37:554/video',
      last: undefined,
      address: '172.29.0.37',
    });
    expect(url).toBe('rtsp://172.29.0.37:554/video');
  });

  it('falls back to the last URL when the stream counter is wedged', async () => {
    // Seen on the real printer: 2/2 streams "connected", nobody watching,
    // every Cmd 386 refused - and the RTSP server still serving video.
    const warnings: string[] = [];
    const url = await resolveVideoUrl({
      enable: refuse(VideoAck.ExceededMaxStreams),
      last: 'rtsp://10.0.0.9:554/video',
      address: '172.29.0.37',
      onWarn: (w) => warnings.push(w),
    });
    expect(url).toBe('rtsp://10.0.0.9:554/video');
    expect(warnings[0]).toContain('trying rtsp://10.0.0.9:554/video anyway');
  });

  it('falls back to the observed default URL when there is no last one', async () => {
    const url = await resolveVideoUrl({
      enable: refuse(VideoAck.ExceededMaxStreams),
      last: undefined,
      address: '172.29.0.37',
    });
    expect(url).toBe('rtsp://172.29.0.37:554/video');
  });

  it('still fails when the printer has no camera', async () => {
    await expect(
      resolveVideoUrl({ enable: refuse(VideoAck.NoCamera), last: 'rtsp://x', address: 'x' }),
    ).rejects.toThrow('camera does not exist');
  });

  it('still fails when there is nothing to fall back to', async () => {
    await expect(
      resolveVideoUrl({
        enable: refuse(VideoAck.ExceededMaxStreams),
        last: undefined,
        address: undefined,
      }),
    ).rejects.toThrow('maximum simultaneous streaming limit');
  });
});
