import { EventEmitter } from 'node:events';
import {
  type PrinterAttributes,
  type PrinterStatus,
  type PrintInfo,
  PrintStatus,
  progressPercent,
  remainingMs,
} from '@cthulhu/sdcp';

export interface PrinterView {
  connected: boolean;
  address: string | undefined;
  mainboardId: string | undefined;
  machineStatus: number[];
  print: {
    status: number | undefined;
    statusLabel: string;
    filename: string | undefined;
    currentLayer: number | undefined;
    totalLayer: number | undefined;
    progressPercent: number | undefined;
    remainingMs: number | undefined;
    errorNumber: number | undefined;
    taskId: string | undefined;
  };
  releaseFilmState: number | undefined;
  attributes: PrinterAttributes | undefined;
  updatedAt: string | undefined;
}

export const PRINT_STATUS_LABELS: Record<number, string> = {
  [PrintStatus.Idle]: 'Idle',
  [PrintStatus.Homing]: 'Homing',
  [PrintStatus.Dropping]: 'Dropping',
  [PrintStatus.Exposuring]: 'Exposing',
  [PrintStatus.Lifting]: 'Lifting',
  [PrintStatus.Pausing]: 'Pausing',
  [PrintStatus.Paused]: 'Paused',
  [PrintStatus.Stopping]: 'Stopping',
  [PrintStatus.Stopped]: 'Stopped',
  [PrintStatus.Complete]: 'Complete',
  [PrintStatus.FileChecking]: 'Checking file',
};

/** A print that has ended, one way or another. */
function isTerminal(code: number | undefined): boolean {
  return code === PrintStatus.Complete || code === PrintStatus.Stopped || code === PrintStatus.Idle;
}

export function printStatusLabel(code: number | undefined): string {
  if (code === undefined) return 'Unknown';
  // Never invent a label. The docs are FDM; an SLA machine may send codes we
  // have not seen, and showing the number beats showing a confident lie.
  return PRINT_STATUS_LABELS[code] ?? `Unknown (${code})`;
}

export interface StoreEvents {
  update: [PrinterView];
  /**
   * Emitted once when a print begins, carrying the taskId the printer
   * assigned. Edge-triggered on the taskId changing, NOT on the REST call -
   * so a print started from the machine's own touchscreen is recorded too,
   * and so the row carries the real taskId rather than an empty string.
   */
  printStarted: [
    { filename: string | undefined; taskId: string | undefined; totalLayer: number | undefined },
  ];
  /** Emitted once per print completion, for notifications and history. */
  printFinished: [{ filename: string | undefined; taskId: string | undefined }];
}

/**
 * Holds the current printer view and fans changes out.
 *
 * Completion is edge-triggered: the printer keeps reporting Complete until
 * something else happens, so a level-triggered check would notify on every
 * status push and buzz the phone dozens of times.
 */
export class PrinterStore extends EventEmitter<StoreEvents> {
  private view: PrinterView = {
    connected: false,
    address: undefined,
    mainboardId: undefined,
    machineStatus: [],
    print: {
      status: undefined,
      statusLabel: 'Unknown',
      filename: undefined,
      currentLayer: undefined,
      totalLayer: undefined,
      progressPercent: undefined,
      remainingMs: undefined,
      errorNumber: undefined,
      taskId: undefined,
    },
    releaseFilmState: undefined,
    attributes: undefined,
    updatedAt: undefined,
  };

  private lastPrintStatus: number | undefined;
  private lastTaskId: string | undefined;

  snapshot(): PrinterView {
    return structuredClone(this.view);
  }

  setConnection(connected: boolean, address?: string, mainboardId?: string): void {
    this.view.connected = connected;
    if (address !== undefined) this.view.address = address;
    if (mainboardId !== undefined) this.view.mainboardId = mainboardId;
    this.touch();
  }

  applyStatus(status: PrinterStatus): void {
    const info: PrintInfo = status.printInfo;
    this.view.machineStatus = status.machineStatus;
    this.view.print = {
      status: info.status,
      statusLabel: printStatusLabel(info.status),
      filename: info.filename,
      currentLayer: info.currentLayer,
      totalLayer: info.totalLayer,
      progressPercent: progressPercent(info),
      remainingMs: remainingMs(info),
      errorNumber: info.errorNumber,
      taskId: info.taskId,
    };
    this.view.releaseFilmState = status.devicesStatus.releaseFilmState;

    const previous = this.lastPrintStatus;
    const previousTask = this.lastTaskId;
    this.lastPrintStatus = info.status;
    this.lastTaskId = info.taskId;
    this.touch();

    // A new, non-empty taskId means a print has begun - whether we started it
    // over REST or somebody pressed print on the machine itself.
    //
    // TERMINAL states are excluded. On connecting to a printer that is still
    // showing the LAST print's Complete/Stopped, the first status frame
    // carries an unseen taskId, and without this guard it would be recorded
    // as a brand new print that started and ended in the same millisecond.
    if (info.taskId && info.taskId !== previousTask && !isTerminal(info.status)) {
      this.emit('printStarted', {
        filename: info.filename,
        taskId: info.taskId,
        totalLayer: info.totalLayer,
      });
    }

    // Only on a transition we actually WITNESSED. `previous === undefined`
    // means this is the first frame since connecting, so a printer sitting at
    // Complete from an earlier print would otherwise fire a "Print finished"
    // notification on every server restart - for a print we never saw run.
    if (
      info.status === PrintStatus.Complete &&
      previous !== undefined &&
      previous !== PrintStatus.Complete
    ) {
      this.emit('printFinished', { filename: info.filename, taskId: info.taskId });
    }
  }

  applyAttributes(attributes: PrinterAttributes): void {
    this.view.attributes = attributes;
    this.touch();
  }

  private touch(): void {
    this.view.updatedAt = new Date().toISOString();
    this.emit('update', this.snapshot());
  }
}
