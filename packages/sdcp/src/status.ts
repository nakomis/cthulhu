/**
 * Status and attributes parsing.
 *
 * Follows the OFFICIAL specification, which is written for resin printers:
 *   https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0
 *
 * Every field is still optional and every read still defensive, and `raw` is
 * always preserved. The spec is generic across Chitubox boards, so this
 * printer may deviate; where a real capture and the spec disagree, the
 * capture wins. See CTHU-2.
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
   * Release film health. Misspelled `RelaseFilmState` IN THE SPECIFICATION
   * ITSELF, not just in one firmware. Genuinely worth surfacing on an SLA
   * machine - the film is a consumable that fails.
   */
  releaseFilmState: number | undefined;
  /** The LCD is the other consumable that wears out. */
  lcdStatus: number | undefined;
  tempSensorStatusOfUVLED: number | undefined;
  sgStatus: number | undefined;
  zMotorStatus: number | undefined;
  xMotorStatus: number | undefined;
  rotateMotorStatus: number | undefined;
}

export interface PrinterStatus {
  machineStatus: number[];
  previousStatus: number | undefined;
  printInfo: PrintInfo;
  devicesStatus: DevicesStatus;
  /** Cumulative exposure time of the LCD, in seconds. A wear indicator. */
  printScreen: number | undefined;
  /**
   * Release film USE COUNT, in layers - distinct from releaseFilmState.
   * Counts up across prints: 0 to 1000 over a 1000-layer print.
   */
  releaseFilmUses: number | undefined;
  tempOfUVLED: number | undefined;
  /** Enclosure temperature. There is no nozzle or hotbed on an SLA machine. */
  tempOfBox: number | undefined;
  tempTargetBox: number | undefined;
  timeLapseStatus: number | undefined;
  /** 0 disconnected, 1 connected. Distinguishes "no camera" from "camera busy". */
  cameraStatus: number | undefined;
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

/**
 * The self-check block. The spec puts it in status; the Mars 5 Ultra
 * (firmware V1.5.0) sends it only in ATTRIBUTES, and without XMotorStatus -
 * it has a tilting vat, not an X axis.
 */
function parseDevicesStatus(devices: Record<string, unknown>): DevicesStatus {
  return {
    releaseFilmState: num(readMisspelled(devices, WIRE_TYPOS.releaseFilmState, 'ReleaseFilmState')),
    lcdStatus: num(devices.LCDStatus),
    tempSensorStatusOfUVLED: num(devices.TempSensorStatusOfUVLED),
    sgStatus: num(devices.SgStatus),
    zMotorStatus: num(devices.ZMotorStatus),
    xMotorStatus: num(devices.XMotorStatus),
    rotateMotorStatus: num(devices.RotateMotorStatus),
  };
}

export function parseStatus(raw: unknown): PrinterStatus {
  const root = obj(raw);
  // Payloads arrive either bare or wrapped in { Status: {...} }.
  const status = obj(root.Status ?? root);
  const printInfo = obj(status.PrintInfo);
  const devices = obj(status.DevicesStatus);

  return {
    machineStatus: numArray(status.CurrentStatus ?? status.MachineStatus),
    previousStatus: num(status.PreviousStatus),
    printScreen: num(status.PrintScreen),
    releaseFilmUses: num(status.ReleaseFilm),
    tempOfUVLED: num(status.TempOfUVLED),
    tempOfBox: num(status.TempOfBox),
    tempTargetBox: num(status.TempTargetBox),
    timeLapseStatus: num(status.TimeLapseStatus),
    cameraStatus: num(status.CameraStatus),
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
    devicesStatus: parseDevicesStatus(devices),
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
  /**
   * X/Y/Z build volume in mm, as the printer reports it. The Mars 5 Ultra
   * says 218.88x128.88x220, although Elegoo publish 153.36 x 77.76 x 165.
   */
  xyzSize: string | undefined;
  /**
   * 2 on the Mars 5 Ultra, not the 1 first assumed. The proxy still holds a
   * single upstream, leaving a slot for the Elegoo app.
   */
  maximumVideoStreamAllowed: number | undefined;
  maximumCloudSdcpServicesAllowed: number | undefined;
  numberOfVideoStreamConnected: number | undefined;
  /** The self-check block; see parseDevicesStatus. */
  devicesStatus: DevicesStatus;
  /** 0 disconnected, 1 connected. In attributes, not status, on this printer. */
  cameraStatus: number | undefined;
  /** Recommended release film life, in layers. 60000 on the Mars 5 Ultra. */
  releaseFilmMax: number | undefined;
  /** 1 when a USB stick is inserted. */
  usbDiskStatus: number | undefined;
  /** Free internal storage, in bytes. */
  remainingMemory: number | undefined;
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
    devicesStatus: parseDevicesStatus(obj(a.DevicesStatus)),
    cameraStatus: num(a.CameraStatus),
    releaseFilmMax: num(a.ReleaseFilmMax),
    usbDiskStatus: num(a.UsbDiskStatus),
    remainingMemory: num(a.RemainingMemory),
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
