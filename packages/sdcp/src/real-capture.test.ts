import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MachineStatus, PrintStatus } from './protocol.js';
import { parseAttributes, parseStatus, remainingMs } from './status.js';

/**
 * Every frame of a real 1000-layer print on an Elegoo Mars 5 Ultra (firmware
 * V1.5.0), recorded with `cthulhu-sdcp watch --record` on 23 September 2026.
 * The print failed mechanically - the vat was not seated - but the printer
 * never knew, and neither does this capture: it ran to Complete.
 */
const rows = readFileSync(
  join(import.meta.dirname, '../fixtures/mars5ultra-v1.5.0-rook-print.jsonl'),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as { at: string; kind: string; frame: unknown });

const statuses = rows.filter((r) => r.kind === 'status').map((r) => parseStatus(r.frame));
const attributes = rows.filter((r) => r.kind === 'attributes').map((r) => parseAttributes(r.frame));

describe('a real print, frame by frame', () => {
  it('parses every frame', () => {
    expect(statuses.length).toBeGreaterThan(2900);
    expect(attributes.length).toBeGreaterThan(0);
    for (const s of statuses) expect(s.printInfo.status).toBeTypeOf('number');
  });

  it('reads the release film health from attributes, misspelling and all', () => {
    for (const a of attributes) {
      expect(a.devicesStatus.releaseFilmState).toBe(1);
      expect(a.releaseFilmMax).toBe(60000);
      expect(a.maximumVideoStreamAllowed).toBe(2);
    }
  });

  it('carries no device block, box temperature or coordinates in status', () => {
    for (const s of statuses) {
      expect(s.devicesStatus.releaseFilmState).toBeUndefined();
      expect(s.tempOfBox).toBeUndefined();
      expect(s.currentCoord).toBeUndefined();
      expect(s.tempOfUVLED).toBeTypeOf('number');
    }
  });

  it('cycles dropping, exposing, lifting for every layer, with layers never going back', () => {
    const printing = statuses.filter((s) => s.machineStatus.includes(MachineStatus.Printing));
    const seen = new Set(printing.map((s) => s.printInfo.status));
    for (const code of [PrintStatus.Homing, PrintStatus.Dropping, PrintStatus.Exposuring]) {
      expect(seen).toContain(code);
    }
    expect(seen).toContain(PrintStatus.Lifting);

    let last = 0;
    for (const s of printing) {
      const layer = s.printInfo.currentLayer ?? 0;
      expect(layer).toBeGreaterThanOrEqual(last);
      last = layer;
    }
    expect(last).toBe(1000);
  });

  it('ends a NORMAL print Stopping, then Complete', () => {
    // The reason the UI says "Finishing" for status 7 when no layers are left.
    // Changes only: the printer repeats a state until the next one.
    const changes = statuses.filter(
      (s, i) => i === 0 || s.printInfo.status !== statuses[i - 1]?.printInfo.status,
    );
    const tail = changes.slice(-3);
    expect(tail.map((s) => s.printInfo.status)).toEqual([
      PrintStatus.Stopping,
      PrintStatus.Complete,
      PrintStatus.Idle,
    ]);
    expect(tail[0]?.printInfo.currentLayer).toBe(1000);
  });

  it('reports ticks in milliseconds', () => {
    // 8,093,248 early on; the touchscreen said 2h 14m. Refined to 7,811,812.
    const first = statuses.find((s) => (s.printInfo.totalTicks ?? 0) > 0);
    expect(first?.printInfo.totalTicks).toBe(8093248);
    expect(remainingMs(first?.printInfo ?? ({} as never))).toBeGreaterThan(2 * 3600_000);
  });

  it('counts release film uses in layers', () => {
    expect(statuses[0]?.releaseFilmUses).toBe(0);
    expect(statuses.at(-1)?.releaseFilmUses).toBe(1000);
  });
});
