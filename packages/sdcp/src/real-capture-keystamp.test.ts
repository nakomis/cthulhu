import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MachineStatus, PrintStatus } from './protocol.js';
import { parseAttributes, parseStatus } from './status.js';

/**
 * Every frame of the first print started through cthulhu: keystamp.goo, 893
 * layers, on 24 September 2026 (firmware V1.5.0), recorded with
 * `cthulhu-sdcp watch --record`. It printed straight after the rook in
 * real-capture.test.ts, so it opens on the rook's finished status, and the
 * recording stops at Complete, before the printer settles back to Idle.
 */
const rows = readFileSync(
  join(import.meta.dirname, '../fixtures/mars5ultra-v1.5.0-keystamp-print.jsonl'),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as { at: string; kind: string; frame: unknown });

const statuses = rows.filter((r) => r.kind === 'status').map((r) => parseStatus(r.frame));
const attributes = rows.filter((r) => r.kind === 'attributes').map((r) => parseAttributes(r.frame));
const keystamp = statuses.filter((s) => s.printInfo.filename === 'keystamp.goo');

describe("cthulhu's first print, frame by frame", () => {
  it('parses every frame', () => {
    expect(statuses.length).toBeGreaterThan(2800);
    expect(attributes.length).toBeGreaterThan(80);
    for (const s of statuses) expect(s.printInfo.status).toBeTypeOf('number');
  });

  it('opens on the previous print, still named until a new one starts', () => {
    const first = statuses[0]?.printInfo;
    expect(first?.filename).toBe('ROOK.goo');
    expect(first?.status).toBe(PrintStatus.Idle);
    expect(first?.currentLayer).toBe(1000);
  });

  it('says Printing a frame before it fills in the print', () => {
    // The first frame after the start command: machine Printing, print info
    // still Idle at 0 of 0 layers. Anything dividing by totalLayer must cope.
    const printing = keystamp.filter((s) => s.machineStatus.includes(MachineStatus.Printing));
    const blank = printing.filter((s) => s.printInfo.totalLayer === 0);
    expect(blank).toHaveLength(1);
    expect(blank[0]?.printInfo.status).toBe(PrintStatus.Idle);
    expect(blank[0]).toBe(printing[0]);
  });

  it('climbs through all 893 layers without going back', () => {
    const printing = keystamp.filter(
      (s) => s.machineStatus.includes(MachineStatus.Printing) && s.printInfo.totalLayer !== 0,
    );
    let last = 0;
    for (const s of printing) {
      expect(s.printInfo.totalLayer).toBe(893);
      const layer = s.printInfo.currentLayer ?? 0;
      expect(layer).toBeGreaterThanOrEqual(last);
      last = layer;
    }
    expect(last).toBe(893);
  });

  it('ends Stopping, then Complete, like the rook', () => {
    const changes = keystamp.filter(
      (s, i) => i === 0 || s.printInfo.status !== keystamp[i - 1]?.printInfo.status,
    );
    expect(changes.slice(-2).map((s) => s.printInfo.status)).toEqual([
      PrintStatus.Stopping,
      PrintStatus.Complete,
    ]);
  });

  it('keeps counting release film uses across prints', () => {
    // The rook left it at 1000; one use per layer after that.
    expect(statuses[0]?.releaseFilmUses).toBe(1000);
    expect(statuses.at(-1)?.releaseFilmUses).toBe(1000 + 893);
  });

  it('reports more video streams than it allows once its count has stuck', () => {
    // Why cthulhu cannot trust NumberOfVideoStreamConnected, nor Cmd 386's
    // Ack 1 ("exceeded the maximum"): it read 4 of 2 while nobody watched.
    const counts = attributes.map((a) => a.numberOfVideoStreamConnected ?? 0);
    expect(Math.max(...counts)).toBe(4);
    for (const a of attributes) expect(a.maximumVideoStreamAllowed).toBe(2);
  });
});
