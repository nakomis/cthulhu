import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMagicFile,
  generateZOffsetGcode,
  listMagicFiles,
  MagicFileError,
} from './magic-files.js';

describe('generateZOffsetGcode', () => {
  it('matches the file verified working on the real printer, byte for byte', () => {
    // fixtures/zoff-3.2mm.gcode is zoff-3.2mm.gcode from Wham Bam Official's
    // instructions, applied to the Mars 5 Ultra (firmware V1.5.0) on
    // 2026-09-28 to fit a magnetic flex plate - the reference this generator
    // is built against, CRLF and all.
    const golden = readFileSync(join(import.meta.dirname, '../fixtures/zoff-3.2mm.gcode'), 'utf8');
    expect(generateZOffsetGcode(3.2)).toBe(golden);
  });

  it('reproduces Elegoo defaults exactly at offset 0, the reset file', () => {
    const text = generateZOffsetGcode(0);
    // Every active (uncommented) value line is the stock value, unchanged.
    expect(text).toContain('M5000 I4 X21.000000\r\n');
    expect(text).toContain('M5000 I4 Y3.000000\r\n');
    expect(text).toContain('M5000 I204 A35.000000\r\n');
    expect(text).toContain('M5000 I204 B2.000000\r\n');
    expect(text).toContain('M5000 I205 A2.000000\r\n');
    expect(text).toContain('M5000 I205 B-2.000000\r\n');
  });

  it('uses CRLF throughout, as the touchscreen firmware expects', () => {
    const text = generateZOffsetGcode(1.5);
    expect(text).not.toMatch(/(?<!\r)\n/);
  });

  it('keeps the stock line as a comment directly above its replacement', () => {
    const text = generateZOffsetGcode(2.5);
    expect(text).toContain(
      ';M5000 I4 X21.000000 ;The maximum abnormal line in the actual resin detection stage (mm)\r\nM5000 I4 X23.500000\r\n',
    );
  });

  it('rounds a value like the levelling end that crosses zero without float noise', () => {
    // -2 + 2.5 = 0.5, but naive float addition can land on 0.49999999999999994.
    const text = generateZOffsetGcode(2.5);
    expect(text).toContain('M5000 I205 B0.500000\r\n');
  });

  it('ends with the save command', () => {
    expect(generateZOffsetGcode(3.2)).toMatch(/M5999 I0 ;Save configuration\r\n$/);
  });
});

describe('listMagicFiles', () => {
  it('offers the Z-offset entry when PLATE_Z_OFFSET_MM is configured', () => {
    const entries = listMagicFiles({ plateZOffsetMm: 3.2 });
    const zoff = entries.find((e) => e.id === 'zoff');
    expect(zoff).toMatchObject({
      name: 'Z-offset',
      filename: 'zoff-3.2mm.gcode',
      description: '+3.2 mm on Elegoo defaults',
      available: true,
    });
    expect(zoff?.reason).toBeUndefined();
  });

  it('marks the Z-offset entry unavailable, with a reason, when unconfigured', () => {
    const entries = listMagicFiles({ plateZOffsetMm: undefined });
    const zoff = entries.find((e) => e.id === 'zoff');
    expect(zoff?.available).toBe(false);
    expect(zoff?.reason).toMatch(/PLATE_Z_OFFSET_MM/);
  });

  it('always offers Reset Z-offset, regardless of configuration', () => {
    const entries = listMagicFiles({ plateZOffsetMm: undefined });
    const reset = entries.find((e) => e.id === 'reset');
    expect(reset).toMatchObject({
      name: 'Reset Z-offset',
      filename: 'zoff-reset.gcode',
      description: 'Elegoo defaults',
      available: true,
    });
  });
});

describe('buildMagicFile', () => {
  it('builds the reset file regardless of configuration', () => {
    const file = buildMagicFile('reset', { plateZOffsetMm: undefined });
    expect(file.filename).toBe('zoff-reset.gcode');
    expect(file.data).toBe(generateZOffsetGcode(0));
  });

  it('builds the Z-offset file from the configured offset', () => {
    const file = buildMagicFile('zoff', { plateZOffsetMm: 3.2 });
    expect(file.filename).toBe('zoff-3.2mm.gcode');
    expect(file.data).toBe(generateZOffsetGcode(3.2));
  });

  it('refuses the Z-offset file when unconfigured', () => {
    expect(() => buildMagicFile('zoff', { plateZOffsetMm: undefined })).toThrow(MagicFileError);
    try {
      buildMagicFile('zoff', { plateZOffsetMm: undefined });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MagicFileError);
      expect((err as MagicFileError).code).toBe('not-configured');
    }
  });

  it('refuses an unknown id', () => {
    try {
      buildMagicFile('bogus', { plateZOffsetMm: 3.2 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MagicFileError);
      expect((err as MagicFileError).code).toBe('not-found');
    }
  });
});
