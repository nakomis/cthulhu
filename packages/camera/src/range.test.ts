import { describe, expect, it } from 'vitest';
import { parseRange } from './range.js';

describe('parseRange', () => {
  it('returns the whole file, unranged, when there is no Range header', () => {
    expect(parseRange(undefined, 1000)).toEqual({ start: 0, end: 999, partial: false });
  });

  it('parses a start-end range', () => {
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199, partial: true });
  });

  it('parses an open-ended range as far as the end of the file', () => {
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999, partial: true });
  });

  it('parses a suffix range as the last N bytes', () => {
    expect(parseRange('bytes=-500', 1000)).toEqual({ start: 500, end: 999, partial: true });
  });

  it('clamps an end past the file size rather than rejecting it', () => {
    expect(parseRange('bytes=0-9999', 1000)).toEqual({ start: 0, end: 999, partial: true });
  });

  it('clamps a suffix longer than the whole file to the whole file', () => {
    expect(parseRange('bytes=-9999', 1000)).toEqual({ start: 0, end: 999, partial: true });
  });

  it('is invalid when the range starts at or past the end of the file', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid');
    expect(parseRange('bytes=2000-3000', 1000)).toBe('invalid');
  });

  it('is invalid when start is after end', () => {
    expect(parseRange('bytes=500-100', 1000)).toBe('invalid');
  });

  it('treats garbage as no range at all', () => {
    expect(parseRange('nonsense', 1000)).toEqual({ start: 0, end: 999, partial: false });
    expect(parseRange('bytes=', 1000)).toEqual({ start: 0, end: 999, partial: false });
  });
});
