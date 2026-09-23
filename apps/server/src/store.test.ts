import { type PrinterStatus, PrintStatus } from '@cthulhu/sdcp';
import { describe, expect, it, vi } from 'vitest';
import { PrinterStore } from './store.js';

function status(over: Partial<PrinterStatus['printInfo']> = {}): PrinterStatus {
  return {
    machineStatus: [1],
    printInfo: {
      status: PrintStatus.Exposuring,
      currentLayer: 1,
      totalLayer: 120,
      currentTicks: 1,
      totalTicks: 120,
      filename: 'hanger.goo',
      errorNumber: 0,
      taskId: 'task-1',
      ...over,
    },
    devicesStatus: {
      releaseFilmState: 1,
      tempOfUVLED: 25,
      tempOfNozzle: undefined,
      tempOfHotbed: undefined,
    },
    currentCoord: '0,0,0',
    raw: {},
  };
}

describe('printFinished', () => {
  it('fires on a transition into Complete that we witnessed', () => {
    const store = new PrinterStore();
    const finished = vi.fn();
    store.on('printFinished', finished);

    store.applyStatus(status({ status: PrintStatus.Exposuring }));
    store.applyStatus(status({ status: PrintStatus.Complete }));

    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on the first frame after connecting to an already-Complete printer', () => {
    // Otherwise every server restart while the printer sits at Complete sends
    // a spurious "Print finished" notification for a print it never saw run.
    // Observed for real: a phantom history row that started and finished in
    // the same millisecond.
    const store = new PrinterStore();
    const finished = vi.fn();
    store.on('printFinished', finished);

    store.applyStatus(status({ status: PrintStatus.Complete }));

    expect(finished).not.toHaveBeenCalled();
  });

  it('fires only ONCE, however many Complete frames arrive', () => {
    // The printer keeps reporting Complete until something else happens, so a
    // level-triggered check would buzz the phone on every status push.
    const store = new PrinterStore();
    const finished = vi.fn();
    store.on('printFinished', finished);

    store.applyStatus(status({ status: PrintStatus.Lifting }));
    store.applyStatus(status({ status: PrintStatus.Complete }));
    store.applyStatus(status({ status: PrintStatus.Complete }));
    store.applyStatus(status({ status: PrintStatus.Complete }));

    expect(finished).toHaveBeenCalledTimes(1);
  });
});

describe('printStarted', () => {
  it('fires for a new taskId on a running print', () => {
    const store = new PrinterStore();
    const started = vi.fn();
    store.on('printStarted', started);

    store.applyStatus(status({ taskId: 'new-task', status: PrintStatus.Homing }));

    expect(started).toHaveBeenCalledTimes(1);
    expect(started.mock.calls[0]?.[0]).toMatchObject({ filename: 'hanger.goo', totalLayer: 120 });
  });

  it('does NOT fire for an unseen taskId that is already in a terminal state', () => {
    // Connecting to a printer still showing the LAST print's Complete would
    // otherwise record it as a brand new print.
    const store = new PrinterStore();
    const started = vi.fn();
    store.on('printStarted', started);

    store.applyStatus(status({ taskId: 'old-task', status: PrintStatus.Complete }));
    store.applyStatus(status({ taskId: 'older', status: PrintStatus.Stopped }));
    store.applyStatus(status({ taskId: 'idle-one', status: PrintStatus.Idle }));

    expect(started).not.toHaveBeenCalled();
  });

  it('does not re-fire while the same print continues', () => {
    const store = new PrinterStore();
    const started = vi.fn();
    store.on('printStarted', started);

    store.applyStatus(status({ status: PrintStatus.Homing }));
    store.applyStatus(status({ status: PrintStatus.Dropping }));
    store.applyStatus(status({ status: PrintStatus.Exposuring }));

    expect(started).toHaveBeenCalledTimes(1);
  });
});
