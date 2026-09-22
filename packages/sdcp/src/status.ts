/**
 * Status and attributes parsing.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WRITTEN AGAINST THE COMMUNITY DOCS, WHICH DESCRIBE AN FDM PRINTER.
 *
 * Every field here is optional and every read is defensive, because the
 * Mars 5 Ultra is SLA and is expected to omit, rename or repurpose a good
 * portion of this. `raw` is always preserved so nothing is lost when the
 * shape turns out to differ - swap the fixtures, widen the types, and the
 * transport underneath does not change. See CTHU-2.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { readMisspelled, WIRE_TYPOS } from './protocol.js';

export interface PrintInfo {
  status: number | undefined;
  currentLayer: number | undefined;
  totalLayer: number | undefined;
  currentTicks: number | undefined;
  totalTicks: number | undefined;
  filename: string | undefined;
  errorNumber: number | undefined;
  taskId: string | undefined;
}

export interface DevicesStatus {
  /**
   * Release film health. Misspelled `RelaseFilmState` on the wire. Genuinely
   * worth surfacing on an SLA machine - the film is a consumable that fails.
   */
  releaseFilmState: number | undefined;
  tempOfUVLED: number | undefined;
  /** Present on FDM; expected to be absent or meaningless here. */
  tempOfNozzle: number | undefined;
  tempOfHotbed: number | undefined;
}

export interface PrinterStatus {
  machineStatus: number[];
  printInfo: PrintInfo;
  devicesStatus: DevicesStatus;
  /** Misspelled `CurrenCoord` on the wire. */
  currentCoord: string | undefined;
  /** The untouched payload. Never drop this - it is the audit trail. */
  raw: Record<string, unknown>;
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Machine status arrives as an array of codes; tolerate a bare number too. */
function numArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.filter((v): v is number => typeof v === 'number');
  const single = num(value);
  return single === undefined ? [] : [single];
}

export function parseStatus(raw: unknown): PrinterStatus {
  const root = obj(raw);
  // Payloads arrive either bare or wrapped in { Status: {...} }.
  const status = obj(root.Status ?? root);
  const printInfo = obj(status.PrintInfo);
  const devices = obj(status.DevicesStatus);

  return {
    machineStatus: numArray(status.CurrentStatus ?? status.MachineStatus),
    printInfo: {
      status: num(printInfo.Status),
      currentLayer: num(printInfo.CurrentLayer),
      totalLayer: num(printInfo.TotalLayer),
      currentTicks: num(printInfo.CurrentTicks),
      totalTicks: num(printInfo.TotalTicks),
      filename: str(printInfo.Filename),
      errorNumber: num(printInfo.ErrorNumber),
      taskId: str(printInfo.TaskId),
    },
    devicesStatus: {
      releaseFilmState: num(
        readMisspelled(devices, WIRE_TYPOS.releaseFilmState, 'ReleaseFilmState'),
      ),
      tempOfUVLED: num(devices.TempOfUVLED),
      tempOfNozzle: num(devices.TempOfNozzle),
      tempOfHotbed: num(devices.TempOfHotbed),
    },
    currentCoord: str(readMisspelled(status, WIRE_TYPOS.currentCoord, 'CurrentCoord')),
    raw: root,
  };
}

export interface PrinterAttributes {
  name: string | undefined;
  machineName: string | undefined;
  brandName: string | undefined;
  mainboardId: string | undefined;
  firmwareVersion: string | undefined;
  protocolVersion: string | undefined;
  resolution: string | undefined;
  /** X/Y/Z build volume in mm. Mars 5 Ultra: 153.36 x 77.76 x 165. */
  xyzSize: string | undefined;
  /** HARD LIMIT, expected to be 1. The camera proxy design depends on it. */
  maximumVideoStreamAllowed: number | undefined;
  maximumCloudSdcpServicesAllowed: number | undefined;
  numberOfVideoStreamConnected: number | undefined;
  raw: Record<string, unknown>;
}

export function parseAttributes(raw: unknown): PrinterAttributes {
  const root = obj(raw);
  const a = obj(root.Attributes ?? root);
  return {
    name: str(a.Name),
    machineName: str(a.MachineName),
    brandName: str(a.BrandName),
    mainboardId: str(a.MainboardID),
    firmwareVersion: str(a.FirmwareVersion),
    protocolVersion: str(a.ProtocolVersion),
    resolution: str(a.Resolution),
    xyzSize: str(a.XYZsize ?? a.XYZSize),
    maximumVideoStreamAllowed: num(a.MaximumVideoStreamAllowed),
    maximumCloudSdcpServicesAllowed: num(
      readMisspelled(a, WIRE_TYPOS.maximumCloudServices, 'MaximumCloudSDCPServicesAllowed'),
    ),
    numberOfVideoStreamConnected: num(a.NumberOfVideoStreamConnected),
    raw: root,
  };
}

/** Remaining print time in milliseconds, or undefined if not derivable. */
export function remainingMs(info: PrintInfo): number | undefined {
  const { currentTicks, totalTicks } = info;
  if (currentTicks === undefined || totalTicks === undefined) return undefined;
  if (totalTicks <= 0 || currentTicks < 0) return undefined;
  return Math.max(0, totalTicks - currentTicks);
}

/** Progress 0-100 from layers, falling back to ticks. */
export function progressPercent(info: PrintInfo): number | undefined {
  const byLayer = ratio(info.currentLayer, info.totalLayer);
  if (byLayer !== undefined) return byLayer;
  return ratio(info.currentTicks, info.totalTicks);
}

function ratio(current: number | undefined, total: number | undefined): number | undefined {
  if (current === undefined || total === undefined || total <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((current / total) * 100)));
}
