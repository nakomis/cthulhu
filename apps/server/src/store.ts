import { EventEmitter } from 'node:events';
import {
  type PrinterAttributes,
  type PrinterStatus,
  type PrintInfo,
  PrintStatus,
  printErrorMessage,
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
    /** The printer's own estimate of the whole print (TotalTicks), in ms. */
    totalMs: number | undefined;
    errorNumber: number | undefined;
    /** What the error number actually means, or null when there is none. */
    errorMessage: string | null;
    taskId: string | undefined;
  };
  releaseFilmState: number | undefined;
  /** Recommended release film life in layers, to set releaseFilmUses against. */
  releaseFilmMax: number | undefined;
  /** Cumulative LCD exposure seconds - a consumable wear indicator. */
  printScreen: number | undefined;
  /** Release film use count, distinct from its health flag. */
  releaseFilmUses: number | undefined;
  /** 0 disconnected, 1 connected. Lets the UI distinguish absent from busy. */
  cameraStatus: number | undefined;
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

export function printStatusLabel(
  code: number | undefined,
  info?: Pick<PrintInfo, 'currentLayer' | 'totalLayer'>,
): string {
  if (code === undefined) return 'Unknown';
  // A print that ends normally passes through Stopping too - for about 25
  // seconds after its last layer, on the real printer. Only call it Stopping
  // when layers were left.
  if (
    code === PrintStatus.Stopping &&
    info?.totalLayer &&
    (info.currentLayer ?? 0) >= info.totalLayer
  ) {
    return 'Finishing';
  }
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
    {
      filename: string | undefined;
      taskId: string | undefined;
      totalLayer: number | undefined;
      /** When the print began: now, less the printer's elapsed ticks. */
      startedAt: string;
    },
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
      totalMs: undefined,
      errorNumber: undefined,
      errorMessage: null,
      taskId: undefined,
    },
    releaseFilmState: undefined,
    releaseFilmMax: undefined,
    printScreen: undefined,
    releaseFilmUses: undefined,
    cameraStatus: undefined,
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
      statusLabel: printStatusLabel(info.status, info),
      filename: info.filename,
      currentLayer: info.currentLayer,
      totalLayer: info.totalLayer,
      progressPercent: progressPercent(info),
      remainingMs: remainingMs(info),
      // Only a real estimate: the printer sends 0 until the file is loaded.
      totalMs: info.totalTicks && info.totalTicks > 0 ? info.totalTicks : undefined,
      errorNumber: info.errorNumber,
      errorMessage: printErrorMessage(info.errorNumber) ?? null,
      taskId: info.taskId,
    };
    // The spec puts these in status; the Mars 5 Ultra sends them only in
    // attributes. Take whichever arrives, and never let an absent field
    // overwrite a value the other frame supplied.
    this.view.releaseFilmState =
      status.devicesStatus.releaseFilmState ?? this.view.releaseFilmState;
    this.view.printScreen = status.printScreen;
    this.view.releaseFilmUses = status.releaseFilmUses;
    this.view.cameraStatus = status.cameraStatus ?? this.view.cameraStatus;

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
        // First sight of a print is not its start when cthulhu restarts
        // mid-print, or the print began before it connected. CurrentTicks is
        // the printer's elapsed print time in ms, so work back from it.
        startedAt: new Date(Date.now() - (info.currentTicks ?? 0)).toISOString(),
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
    this.view.releaseFilmState =
      attributes.devicesStatus.releaseFilmState ?? this.view.releaseFilmState;
    this.view.cameraStatus = attributes.cameraStatus ?? this.view.cameraStatus;
    this.view.releaseFilmMax = attributes.releaseFilmMax ?? this.view.releaseFilmMax;
    this.touch();
  }

  private touch(): void {
    this.view.updatedAt = new Date().toISOString();
    this.emit('update', this.snapshot());
  }
}
