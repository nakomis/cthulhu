/**
 * Default payloads for the fake printer.
 *
 * Shaped from a REAL capture of an Elegoo Mars 5 Ultra (firmware V1.5.0,
 * SDCP V3.0.0): packages/sdcp/fixtures/mars5ultra-v1.5.0-rook-print.jsonl.
 * Only the identity differs - a made-up mainboard id and name - so nothing
 * here can be mistaken for the real machine on the LAN.
 *
 * Where the real printer departs from the spec, this follows the printer:
 *   - DevicesStatus (RelaseFilmState and friends) is in ATTRIBUTES only, and
 *     has RotateMotorStatus but no XMotorStatus (a tilting vat, no X axis).
 *   - Status carries no TempOfBox/TempTargetBox, CurrenCoord, PrintScreen or
 *     PreviousStatus; just CurrentStatus, ReleaseFilm, TempOfUVLED,
 *     TimeLapseStatus and PrintInfo.
 *   - MaximumVideoStreamAllowed is 2, not 1.
 *   - SupportFileType is upper case.
 */

export interface PrinterFixture {
  mainboardId: string;
  discovery: Record<string, unknown>;
  attributes: Record<string, unknown>;
  /** Built per-tick from the simulated print state. */
  statusTemplate: Record<string, unknown>;
}

export const MARS_5_ULTRA: PrinterFixture = {
  mainboardId: '000000000001d354',

  discovery: {
    Name: 'Cthulhu Test Rig',
    MachineName: 'Mars 5 Ultra',
    BrandName: 'ELEGOO',
    MainboardIP: '127.0.0.1',
    MainboardID: '000000000001d354',
    ProtocolVersion: 'V3.0.0',
    FirmwareVersion: 'V1.5.0',
  },

  attributes: {
    Name: 'Cthulhu Test Rig',
    MachineName: 'Mars 5 Ultra',
    BrandName: 'ELEGOO',
    ProtocolVersion: 'V3.0.0',
    FirmwareVersion: 'V1.5.0',
    Resolution: '8520x4320',
    // What the printer reports. Elegoo publish 153.36 x 77.76 x 165.
    XYZsize: '218.88x128.88x220',
    MainboardIP: '127.0.0.1',
    MainboardID: '000000000001d354',
    SDCPStatus: 0,
    // Misspelled on the wire - reproduced exactly on purpose.
    MaximumCloudSDCPSercicesAllowed: 0,
    NumberOfCloudSDCPServicesConnected: 0,
    NumberOfVideoStreamConnected: 0,
    MaximumVideoStreamAllowed: 2,
    NetworkStatus: 'wlan',
    UsbDiskStatus: 0,
    Capabilities: ['FILE_TRANSFER', 'PRINT_CONTROL', 'VIDEO_STREAM'],
    SupportFileType: ['CTB', 'GOO'],
    DevicesStatus: {
      TempSensorStatusOfUVLED: 1,
      LCDStatus: 1,
      SgStatus: 1,
      ZMotorStatus: 1,
      RotateMotorStatus: 1,
      // Misspelled on the wire. 1 = healthy.
      RelaseFilmState: 1,
    },
    ReleaseFilmMax: 60000,
    CameraStatus: 1,
    RemainingMemory: 6741819392,
    TLPNoCapPos: 50,
    TLPStartCapPos: 30,
    TLPInterLayers: 10,
  },

  statusTemplate: {
    CurrentStatus: [0],
    ReleaseFilm: 0,
    TempOfUVLED: 19.5,
    TimeLapseStatus: 0,
    PrintInfo: {
      Status: 0,
      CurrentLayer: 0,
      TotalLayer: 0,
      CurrentTicks: 0,
      TotalTicks: 0,
      ErrorNumber: 0,
      Filename: '',
      TaskId: '',
    },
  },
};
