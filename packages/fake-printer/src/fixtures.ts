/**
 * Default payloads for the fake printer.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THESE ARE HYPOTHESISED, NOT OBSERVED.
 *
 * They are shaped from the community docs, which describe the Centauri Carbon
 * (FDM). The Mars 5 Ultra is SLA. Once real traffic has been captured, drop
 * the recording into `fixtures/` and pass it to `createFakePrinter({ fixture })`
 * - the server logic reads from the fixture and does not need changing.
 *
 * Deliberately included because they are almost certainly wrong, and it is
 * better to be obviously wrong in one findable place than subtly wrong
 * everywhere: TempOfNozzle and TempOfHotbed. An SLA machine has neither.
 * ────────────────────────────────────────────────────────────────────────────
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
    MachineName: 'ELEGOO Mars 5 Ultra',
    BrandName: 'ELEGOO',
    MainboardIP: '127.0.0.1',
    MainboardID: '000000000001d354',
    ProtocolVersion: 'V3.0.0',
    FirmwareVersion: 'V1.0.0',
  },

  attributes: {
    Name: 'Cthulhu Test Rig',
    MachineName: 'ELEGOO Mars 5 Ultra',
    BrandName: 'ELEGOO',
    MainboardID: '000000000001d354',
    ProtocolVersion: 'V3.0.0',
    FirmwareVersion: 'V1.0.0',
    Resolution: '11520x5120',
    // Mars 5 Ultra build volume, in mm.
    XYZsize: '153.36x77.76x165',
    // HARD LIMIT. The camera proxy multiplexes because of this.
    MaximumVideoStreamAllowed: 1,
    NumberOfVideoStreamConnected: 0,
    // Misspelled on the wire - reproduced exactly on purpose.
    MaximumCloudSDCPSercicesAllowed: 1,
    NumberOfCloudSDCPServicesConnected: 0,
    SupportFileType: ['goo', 'ctb'],
    DevicesStatus: {
      TempOfUVLED: 25,
      // Misspelled on the wire. 1 = healthy.
      RelaseFilmState: 1,
    },
  },

  statusTemplate: {
    CurrentStatus: [0],
    PreviousStatus: 0,
    PrintScreen: 0,
    ReleaseFilm: 0,
    TempOfUVLED: 25,
    TimeLapseStatus: 0,
    PrintInfo: {
      Status: 0,
      CurrentLayer: 0,
      TotalLayer: 0,
      CurrentTicks: 0,
      TotalTicks: 0,
      Filename: '',
      ErrorNumber: 0,
      TaskId: '',
    },
    DevicesStatus: {
      TempOfUVLED: 25,
      RelaseFilmState: 1,
    },
    // Misspelled on the wire.
    CurrenCoord: '0.000,0.000,0.000',
  },
};
