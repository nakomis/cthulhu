import { MachineStatus, PrintStatus } from '@cthulhu/sdcp';
import type { PrinterFixture } from './fixtures.js';

export interface PrintJob {
  filename: string;
  totalLayer: number;
  /** Wall-clock milliseconds per layer in the simulation. */
  msPerLayer: number;
  taskId: string;
}

/**
 * Simulates a print well enough to exercise the whole stack: layers advance,
 * the status cycles through the SLA phases, pause/resume/stop behave, and the
 * job completes.
 *
 * Time is injected so tests are deterministic and do not sleep.
 */
export class PrinterState {
  private printStatus: number = PrintStatus.Idle;
  private machineStatus: number = MachineStatus.Idle;
  private job: PrintJob | undefined;
  private currentLayer = 0;
  private elapsedMs = 0;
  private errorNumber = 0;

  private readonly fixture: PrinterFixture;

  constructor(fixture: PrinterFixture) {
    this.fixture = fixture;
  }

  get isPrinting(): boolean {
    return this.job !== undefined && this.machineStatus === MachineStatus.Printing;
  }

  startPrint(job: PrintJob): void {
    this.job = job;
    this.currentLayer = 0;
    this.elapsedMs = 0;
    this.errorNumber = 0;
    this.machineStatus = MachineStatus.Printing;
    this.printStatus = PrintStatus.Homing;
  }

  pause(): void {
    if (!this.job) return;
    this.printStatus = PrintStatus.Paused;
  }

  resume(): void {
    if (!this.job) return;
    if (this.printStatus === PrintStatus.Paused) this.printStatus = PrintStatus.Lifting;
  }

  stop(): void {
    if (!this.job) return;
    this.printStatus = PrintStatus.Stopped;
    this.machineStatus = MachineStatus.Idle;
  }

  /**
   * Advance the simulation. The phase cycle is deliberately SLA-flavoured:
   * dropping -> exposuring -> lifting, one layer per full cycle.
   */
  tick(deltaMs: number): void {
    const job = this.job;
    if (!job) return;
    if (this.printStatus === PrintStatus.Paused || this.printStatus === PrintStatus.Stopped) return;
    if (this.printStatus === PrintStatus.Complete) return;

    this.elapsedMs += deltaMs;
    const layer = Math.min(job.totalLayer, Math.floor(this.elapsedMs / job.msPerLayer));
    this.currentLayer = layer;

    if (layer >= job.totalLayer) {
      this.printStatus = PrintStatus.Complete;
      this.machineStatus = MachineStatus.Idle;
      return;
    }

    const phase = Math.floor((this.elapsedMs % job.msPerLayer) / (job.msPerLayer / 3));
    this.printStatus =
      phase === 0
        ? PrintStatus.Dropping
        : phase === 1
          ? PrintStatus.Exposuring
          : PrintStatus.Lifting;
  }

  /** Build a status payload from the fixture template plus live state. */
  snapshot(): Record<string, unknown> {
    const template = structuredClone(this.fixture.statusTemplate);
    const job = this.job;
    const totalTicks = job ? job.totalLayer * job.msPerLayer : 0;

    template.CurrentStatus = [this.machineStatus];
    template.PrintInfo = {
      ...(template.PrintInfo as Record<string, unknown>),
      Status: this.printStatus,
      CurrentLayer: this.currentLayer,
      TotalLayer: job?.totalLayer ?? 0,
      CurrentTicks: Math.min(this.elapsedMs, totalTicks),
      TotalTicks: totalTicks,
      Filename: job?.filename ?? '',
      ErrorNumber: this.errorNumber,
      TaskId: job?.taskId ?? '',
    };
    return template;
  }

  attributes(): Record<string, unknown> {
    return structuredClone(this.fixture.attributes);
  }
}
