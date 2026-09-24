/**
 * SDCP (Smart Device Control Protocol) wire constants and types.
 *
 * Source: https://docs.opencentauri.cc/software/api/ - community documentation
 * written up from the Elegoo Discord.
 *
 * HEALTH WARNING: those docs describe the Centauri Carbon, which is an FDM
 * printer. The Mars 5 Ultra is SLA. Nozzle and bed temperature fields are
 * expected to be absent or meaningless, files are `.goo` rather than `.gcode`,
 * and some status codes may differ. Everything here is a hypothesis until it
 * has been checked against a real capture - see CTHU-2.
 */

/** UDP port the printer listens on for discovery broadcasts. */
export const DISCOVERY_PORT = 3000;

/** Payload broadcast to elicit a discovery response. */
export const DISCOVERY_PAYLOAD = 'M99999';

/** TCP port serving the WebSocket control channel. */
export const WEBSOCKET_PORT = 3030;

/**
 * Primary WebSocket path, followed by fallbacks seen in the wild. Firmware
 * varies, so a client should try them in order rather than assuming the first.
 */
export const WEBSOCKET_PATHS = ['/websocket', '/ws', '/', '/api/websocket', '/sdcp'] as const;

/** Heartbeat is a literal string, not a JSON frame, and is answered with `pong`. */
export const HEARTBEAT_REQUEST = 'ping';
export const HEARTBEAT_RESPONSE = 'pong';

/** Commands the client may send. */
export const Cmd = {
  RefreshStatus: 0,
  RefreshAttributes: 1,
  StartPrint: 128,
  Pause: 129,
  Stop: 130,
  Resume: 131,
  RenamePrinter: 192,
  ListFiles: 258,
  BatchDeleteFiles: 259,
  TerminateFileTransfer: 255,
  HistoryTaskList: 320,
  HistoryTaskDetail: 321,
  SetVideoStream: 386,
  SetTimeLapse: 387,
} as const;

export type CmdValue = (typeof Cmd)[keyof typeof Cmd];

/** Acknowledgement codes returned in response to {@link Cmd.StartPrint}. */
export const StartPrintAck = {
  Ok: 0,
  Busy: 1,
  NotFound: 2,
  Md5Failed: 3,
  FileIoError: 4,
  InvalidResolution: 5,
  UnknownFormat: 6,
  UnknownModel: 7,
} as const;

export const START_PRINT_ACK_MESSAGES: Record<number, string> = {
  [StartPrintAck.Ok]: 'OK',
  [StartPrintAck.Busy]: 'printer is busy',
  [StartPrintAck.NotFound]: 'file not found',
  [StartPrintAck.Md5Failed]: 'MD5 check failed',
  [StartPrintAck.FileIoError]: 'file IO error',
  [StartPrintAck.InvalidResolution]: 'invalid resolution',
  [StartPrintAck.UnknownFormat]: 'unknown file format',
  [StartPrintAck.UnknownModel]: 'unknown model',
};

/**
 * Values of `PrintInfo.ErrorNumber`, from the official specification.
 *
 * Worth distinguishing: "resolution mismatch" means the file was sliced for a
 * different printer, which needs re-slicing, whereas "MD5 check failed" means
 * the transfer was corrupt and simply needs repeating. Reporting either as a
 * bare number leaves the operator to guess which.
 */
export const PrintError = {
  None: 0,
  Md5CheckFailed: 1,
  FileReadFailed: 2,
  ResolutionMismatch: 3,
  FormatMismatch: 4,
  ModelMismatch: 5,
} as const;

export const PRINT_ERROR_MESSAGES: Record<number, string> = {
  [PrintError.None]: 'none',
  [PrintError.Md5CheckFailed]: 'MD5 check failed — the transfer was corrupt, re-upload',
  [PrintError.FileReadFailed]: 'the printer could not read the file',
  [PrintError.ResolutionMismatch]: 'resolution mismatch — sliced for a different printer',
  [PrintError.FormatMismatch]: 'unsupported file format',
  [PrintError.ModelMismatch]: 'model mismatch — sliced for a different machine',
};

/** Human-readable reason for an ErrorNumber, without inventing one. */
export function printErrorMessage(code: number | undefined): string | undefined {
  if (code === undefined || code === PrintError.None) return undefined;
  return PRINT_ERROR_MESSAGES[code] ?? `unknown error ${code}`;
}

/**
 * Print status codes. Note how SLA-flavoured these are - dropping, exposuring,
 * lifting - even in documentation written for an FDM machine.
 */
export const PrintStatus = {
  Idle: 0,
  Homing: 1,
  Dropping: 2,
  Exposuring: 3,
  Lifting: 4,
  Pausing: 5,
  Paused: 6,
  Stopping: 7,
  Stopped: 8,
  Complete: 9,
  FileChecking: 10,
} as const;

/** Machine status codes. */
export const MachineStatus = {
  Idle: 0,
  Printing: 1,
  FileTransferring: 2,
  /** The official spec calls this exposure testing, not "calibrating". */
  ExposureTesting: 3,
  /** The official spec calls this device self-check. */
  DeviceSelfCheck: 4,
} as const;

/**
 * MaximumVideoStreamAllowed on the Mars 5 Ultra: 2. The spec-era assumption
 * was 1. The server still holds a single upstream and fans it out, and drops
 * it when nobody is watching, so the second slot stays free for the Elegoo
 * app. The printer's own attributes are the authority; see CTHU-6.
 */
export const MAX_VIDEO_STREAMS = 2;

/** Acknowledgement codes for Cmd 386 (enable/disable the video stream). */
export const VideoAck = {
  Ok: 0,
  ExceededMaxStreams: 1,
  NoCamera: 2,
  UnknownError: 3,
} as const;

export const VIDEO_ACK_MESSAGES: Record<number, string> = {
  [VideoAck.Ok]: 'OK',
  [VideoAck.ExceededMaxStreams]: 'exceeded the maximum simultaneous streaming limit',
  [VideoAck.NoCamera]: 'camera does not exist',
  [VideoAck.UnknownError]: 'unknown error',
};

/** Response to a discovery broadcast. */
export interface DiscoveryResponse {
  Id: string;
  Data: {
    Name: string;
    MachineName: string;
    BrandName: string;
    MainboardIP: string;
    MainboardID: string;
    ProtocolVersion: string;
    FirmwareVersion: string;
  };
}

/** A discovered printer, flattened into something worth passing around. */
export interface DiscoveredPrinter {
  id: string;
  name: string;
  machineName: string;
  brandName: string;
  address: string;
  mainboardId: string;
  protocolVersion: string;
  firmwareVersion: string;
}

/** Topics, all suffixed with the mainboard id. */
export const topics = {
  request: (mainboardId: string) => `sdcp/request/${mainboardId}`,
  response: (mainboardId: string) => `sdcp/response/${mainboardId}`,
  status: (mainboardId: string) => `sdcp/status/${mainboardId}`,
  attributes: (mainboardId: string) => `sdcp/attributes/${mainboardId}`,
  error: (mainboardId: string) => `sdcp/error/${mainboardId}`,
  notice: (mainboardId: string) => `sdcp/notice/${mainboardId}`,
} as const;

/** The envelope wrapping every client request. */
export interface SdcpRequest<T = Record<string, unknown>> {
  Id: string;
  Topic: string;
  Data: {
    Cmd: CmdValue;
    Data: T;
    RequestID: string;
    MainboardID: string;
    TimeStamp: number;
    From: number;
  };
}

export interface BuildRequestOptions<T> {
  id: string;
  requestId: string;
  mainboardId: string;
  cmd: CmdValue;
  data?: T;
  /** Seconds since the epoch. Injectable so tests are not clock-dependent. */
  timestamp?: number;
  from?: number;
}

/** Build a request envelope. Pure, so it is trivially testable. */
export function buildRequest<T extends Record<string, unknown>>(
  options: BuildRequestOptions<T>,
): SdcpRequest<T | Record<string, unknown>> {
  const { id, requestId, mainboardId, cmd, data = {}, timestamp, from = 0 } = options;
  return {
    Id: id,
    Topic: topics.request(mainboardId),
    Data: {
      Cmd: cmd,
      Data: data,
      RequestID: requestId,
      MainboardID: mainboardId,
      TimeStamp: timestamp ?? Math.floor(Date.now() / 1000),
      From: from,
    },
  };
}

/**
 * Three fields are MISSPELLED in the wire format. They must be sent and parsed
 * exactly as-is. Reading both spellings is cheap insurance in case a firmware
 * update quietly corrects them.
 */
export const WIRE_TYPOS = {
  currentCoord: 'CurrenCoord',
  releaseFilmState: 'RelaseFilmState',
  maximumCloudServices: 'MaximumCloudSDCPSercicesAllowed',
} as const;

/** Read a field that the firmware may spell either correctly or not. */
export function readMisspelled<T>(
  source: Record<string, unknown>,
  misspelled: string,
  corrected: string,
): T | undefined {
  return (source[misspelled] ?? source[corrected]) as T | undefined;
}
