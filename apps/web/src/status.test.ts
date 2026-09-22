import { describe, expect, it } from 'vitest';
import { formatEta, layerProgress, printStatusLabel } from './status.js';

describe('printStatusLabel', () => {
  it('labels known codes', () => {
    expect(printStatusLabel(3)).toBe('Exposing');
    expect(printStatusLabel(9)).toBe('Complete');
  });

  it('does not pretend to know an unmapped code', () => {
    // The docs describe an FDM printer, so an SLA machine may well send codes
    // we have never seen. Showing the number beats showing a wrong label.
    expect(printStatusLabel(42)).toBe('Unknown (42)');
  });
});

describe('layerProgress', () => {
  it.each([
    [0, 100, 0],
    [50, 100, 50],
    [100, 100, 100],
    [1, 3, 33],
  ])('%i of %i layers is %i%%', (current, total, expected) => {
    expect(layerProgress(current, total)).toBe(expected);
  });

  it.each([
    ['zero total', 0, 0],
    ['negative total', 5, -1],
    ['NaN total', 5, Number.NaN],
  ])('returns 0 rather than dividing by %s', (_label, current, total) => {
    expect(layerProgress(current, total)).toBe(0);
  });

  it('clamps a current layer beyond the total', () => {
    expect(layerProgress(120, 100)).toBe(100);
  });
});

describe('formatEta', () => {
  it.each([
    [0, '—'],
    [-1000, '—'],
    [Number.NaN, '—'],
    [60_000, '1m'],
    [7_500_000, '2h 05m'],
    [3_600_000, '1h 00m'],
  ])('formats %s as %s', (ms, expected) => {
    expect(formatEta(ms)).toBe(expected);
  });
});
