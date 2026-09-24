import { describe, expect, it } from 'vitest';
import { LatestFrame } from './latest-frame.js';

const jpeg = (body: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(body), Buffer.from([0xff, 0xd9])]);
const part = (body: string) =>
  Buffer.concat([
    Buffer.from('--frame\r\nContent-type: image/jpeg\r\n\r\n'),
    jpeg(body),
    Buffer.from('\r\n'),
  ]);

describe('LatestFrame', () => {
  it('keeps the last whole JPEG from an MJPEG stream', () => {
    const f = new LatestFrame();
    f.push(Buffer.concat([part('one'), part('two')]));
    expect(f.latest()?.toString('latin1')).toContain('two');
  });

  it('assembles a frame split across chunks', () => {
    const f = new LatestFrame();
    const whole = part('split-frame');
    f.push(whole.subarray(0, 20));
    expect(f.latest()).toBeUndefined();
    f.push(whole.subarray(20));
    expect(f.latest()?.equals(jpeg('split-frame'))).toBe(true);
  });

  it('says nothing about a frame older than asked', () => {
    const f = new LatestFrame();
    f.push(part('old'), 1000);
    expect(f.latest(2000, 2500)).toBeDefined();
    expect(f.latest(2000, 3500)).toBeUndefined();
  });

  it('does not grow without bound on a stream that never closes a frame', () => {
    const f = new LatestFrame({ maxPending: 100 });
    f.push(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200)]));
    f.push(part('after'));
    expect(f.latest()?.toString('latin1')).toContain('after');
  });
});
