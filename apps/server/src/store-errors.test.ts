import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAttributes, parseStatus } from '@cthulhu/sdcp';
import { describe, expect, it, vi } from 'vitest';
import { PrinterStore } from './store.js';

/**
 * The 16 October 2026 failure, RECONSTRUCTED rather than recorded: the real
 * attributes frame from the idle capture, then status frames in the real
 * shape for a print that homed, stopped at layer 0 with ErrorNumber 2, and
 * dropped back to idle. The vat was overfilled; nothing in these frames says
 * so, which is the point of logging the real ones (CTHU-39, CTHU-40).
 */
const rows = readFileSync(
  join(import.meta.dirname, '../fixtures/cthu-39-error-2-reconstructed.jsonl'),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as { kind: string; frame: unknown });

function replay(store: PrinterStore): boolean[] {
  const stale: boolean[] = [];
  for (const row of rows) {
    if (row.kind === 'attributes') store.applyAttributes(parseAttributes(row.frame));
    else {
      store.applyStatus(parseStatus(row.frame));
      stale.push(store.snapshot().print.errorStale);
    }
  }
  return stale;
}

describe('error 2 after homing', () => {
  it('logs the raw status and attributes once, when the error appears', () => {
    const warn = vi.fn();
    replay(new PrinterStore({ warn }));

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]?.[0] as string;
    expect(line).toContain('"Status.PrintInfo.ErrorNumber":2');
    expect(line).toContain('"Filename":"ndfm-tinycrypt-clear.goo"');
    expect(line).toContain('"MaximumCloudSDCPSercicesAllowed"');
  });

  it('shows what error 2 may really mean', () => {
    const store = new PrinterStore();
    replay(store);
    expect(store.snapshot().print.errorMessage).toContain("resin is above the vat's maximum");
  });

  it('calls the error stale only once the printer is idle', () => {
    // Homing, homing, stopped while still busy, then idle twice.
    expect(replay(new PrinterStore())).toEqual([false, false, false, true, true]);
  });
});

describe('error logging', () => {
  const frame = (errorNumber: number) =>
    parseStatus({
      Status: { CurrentStatus: [0], PrintInfo: { Status: 8, ErrorNumber: errorNumber } },
    });

  it('says nothing on connecting to a healthy printer', () => {
    const warn = vi.fn();
    const store = new PrinterStore({ warn });
    store.applyStatus(frame(0));
    store.applyStatus(frame(0));
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a fault already present on connecting, and its clearing', () => {
    const warn = vi.fn();
    const store = new PrinterStore({ warn });
    store.applyStatus(frame(2));
    store.applyStatus(frame(2));
    store.applyStatus(frame(0));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('is not stale while the print is still running', () => {
    const store = new PrinterStore();
    store.applyStatus(
      parseStatus({ Status: { CurrentStatus: [0], PrintInfo: { Status: 3, ErrorNumber: 2 } } }),
    );
    expect(store.snapshot().print.errorStale).toBe(false);
  });
});
