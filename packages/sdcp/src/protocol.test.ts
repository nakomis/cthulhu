import { describe, expect, it } from 'vitest';
import {
  buildRequest,
  Cmd,
  MAX_VIDEO_STREAMS,
  readMisspelled,
  START_PRINT_ACK_MESSAGES,
  StartPrintAck,
  topics,
  WIRE_TYPOS,
} from './protocol.js';

describe('buildRequest', () => {
  it('wraps a command in the SDCP envelope', () => {
    const req = buildRequest({
      id: 'id-1',
      requestId: 'req-1',
      mainboardId: '000000000001d354',
      cmd: Cmd.RefreshStatus,
      timestamp: 1687069655,
    });

    expect(req).toEqual({
      Id: 'id-1',
      Topic: 'sdcp/request/000000000001d354',
      Data: {
        Cmd: 0,
        Data: {},
        RequestID: 'req-1',
        MainboardID: '000000000001d354',
        TimeStamp: 1687069655,
        From: 0,
      },
    });
  });

  it('carries the command payload through', () => {
    const req = buildRequest({
      id: 'id-2',
      requestId: 'req-2',
      mainboardId: 'mb',
      cmd: Cmd.StartPrint,
      data: { Filename: 'cat.goo', StartLayer: 0 },
      timestamp: 1,
    });
    expect(req.Data.Cmd).toBe(128);
    expect(req.Data.Data).toEqual({ Filename: 'cat.goo', StartLayer: 0 });
  });

  it('defaults the timestamp to now, in SECONDS not milliseconds', () => {
    const before = Math.floor(Date.now() / 1000);
    const req = buildRequest({ id: 'a', requestId: 'b', mainboardId: 'c', cmd: Cmd.Pause });
    expect(req.Data.TimeStamp).toBeGreaterThanOrEqual(before);
    // A millisecond timestamp here would be ~1000x too large and the printer
    // would reject it, so pin the magnitude rather than just the type.
    expect(req.Data.TimeStamp).toBeLessThan(before + 5);
  });
});

describe('topics', () => {
  it('suffixes every topic with the mainboard id', () => {
    expect(topics.status('mb1')).toBe('sdcp/status/mb1');
    expect(topics.error('mb1')).toBe('sdcp/error/mb1');
    expect(topics.attributes('mb1')).toBe('sdcp/attributes/mb1');
  });
});

describe('wire typos', () => {
  // These are misspelled in the firmware. Reproducing them exactly is required;
  // a "helpful" correction here would silently break every status read.
  it('preserves the misspellings exactly', () => {
    expect(WIRE_TYPOS.currentCoord).toBe('CurrenCoord');
    expect(WIRE_TYPOS.releaseFilmState).toBe('RelaseFilmState');
    expect(WIRE_TYPOS.maximumCloudServices).toBe('MaximumCloudSDCPSercicesAllowed');
  });

  it('reads the misspelled field when that is what the firmware sends', () => {
    expect(readMisspelled({ RelaseFilmState: 1 }, 'RelaseFilmState', 'ReleaseFilmState')).toBe(1);
  });

  it('reads the corrected field if a firmware update ever fixes it', () => {
    expect(readMisspelled({ ReleaseFilmState: 0 }, 'RelaseFilmState', 'ReleaseFilmState')).toBe(0);
  });

  it('prefers the misspelled field when both are present', () => {
    const both = { RelaseFilmState: 1, ReleaseFilmState: 0 };
    expect(readMisspelled(both, 'RelaseFilmState', 'ReleaseFilmState')).toBe(1);
  });

  it('returns undefined when neither is present', () => {
    expect(readMisspelled({}, 'RelaseFilmState', 'ReleaseFilmState')).toBeUndefined();
  });
});

describe('start print acks', () => {
  it('has a message for every ack code', () => {
    for (const code of Object.values(StartPrintAck)) {
      expect(START_PRINT_ACK_MESSAGES[code]).toBeTypeOf('string');
    }
  });
});

describe('video stream limit', () => {
  // Not a style preference: the camera proxy design depends on this being 1.
  it('is one, which is why the server must multiplex', () => {
    expect(MAX_VIDEO_STREAMS).toBe(2);
  });
});
