import type { Config } from './config.js';

/**
 * Magic Files — small config gcode files sent to the printer's touchscreen,
 * never printed. See CTHU-30 and the README's "What the real printer taught
 * us": a magnetic flex build plate (a 3.1-3.2 mm magnet+steel stack) trips
 * the pre-print "Foreign Material Detected" check, because the six
 * thresholds below are calibrated for the stock glass plate. Raising them
 * by the plate's thickness and saving (M5999 I0) fixes it — verified on the
 * real printer (Mars 5 Ultra, firmware V1.5.0) on 2026-09-28.
 *
 * These can ONLY be run from the printer's own Print menu: Cmd 128 (start
 * print) on a .gcode answers Ack 6 "unknown file format". The upload itself
 * succeeds and the file genuinely lands in /local, but the Cmd 258 listing
 * hides it - so, unlike a normal upload, the server never tries to confirm
 * one with confirmUploaded(); waiting for it to appear would just time out.
 */

/** One threshold the stock Elegoo config gcode sets, and its exact wording. */
interface ZOffsetSetting {
  index: string;
  axis: string;
  stock: number;
  comment: string;
}

// Values and comments lifted verbatim from Elegoo's own config gcode. Raising
// each by the same offset is the whole trick: the plate is thicker, so every
// height the firmware measures from the build surface needs to move up by
// exactly that much.
const SETTINGS: ZOffsetSetting[] = [
  {
    index: 'I4',
    axis: 'X',
    stock: 21,
    comment: 'The maximum abnormal line in the actual resin detection stage (mm)',
  },
  {
    index: 'I4',
    axis: 'Y',
    stock: 3,
    comment: 'The minimum abnormal line in the actual resin detection stage (mm)',
  },
  {
    index: 'I204',
    axis: 'A',
    stock: 35,
    comment:
      'Resin detection starting position (mm), at least greater than the highest liquid level position on the structure to start measurement.',
  },
  {
    index: 'I204',
    axis: 'B',
    stock: 2,
    comment:
      "Resin detection end position (mm), it is recommended to set 1mm or 2mm. Don't stick to the bottom, too close to the bottom will cause misjudgment due to the stress of the membrane.",
  },
  {
    index: 'I205',
    axis: 'A',
    stock: 2,
    comment:
      'Starting position of automatic leveling (mm), it is recommended to be greater than 1mm, and start to level at the place where the film does not produce stress on the platform.',
  },
  {
    index: 'I205',
    axis: 'B',
    stock: -2,
    comment:
      'Ending position of automatic leveling (mm), it is recommended to set -1mm, too large may damage the screen.',
  },
];

function fmt(value: number): string {
  return value.toFixed(6);
}

/**
 * Build the config gcode text for a given Z-offset.
 *
 * Format matches what the touchscreen expects, and what Elegoo's own file
 * uses: CRLF line endings, the stock line kept as a comment immediately
 * above its replacement, a blank line between settings. `offsetMm` 0
 * reproduces Elegoo's stock values exactly - the "reset" file.
 *
 * Checked byte-for-byte against `fixtures/zoff-3.2mm.gcode`, the file
 * applied and verified working on the real printer, at offsetMm 3.2.
 */
export function generateZOffsetGcode(offsetMm: number): string {
  const header =
    offsetMm === 0
      ? '; Elegoo Mars 5 Ultra: stock values (Z-offset reset)'
      : `; Elegoo Mars 5 Ultra: stock values + ${offsetMm.toFixed(1)} mm for a magnetic flex plate (3.1-3.2 mm stack)`;

  const lines: string[] = [header];
  for (const setting of SETTINGS) {
    lines.push(`;M5000 ${setting.index} ${setting.axis}${fmt(setting.stock)} ;${setting.comment}`);
    lines.push(`M5000 ${setting.index} ${setting.axis}${fmt(setting.stock + offsetMm)}`);
    lines.push('');
  }
  lines.push('M5999 I0 ;Save configuration');

  return `${lines.join('\r\n')}\r\n`;
}

export type MagicFileId = 'zoff' | 'reset';

export interface MagicFileEntry {
  id: MagicFileId;
  name: string;
  /** Short - the touchscreen truncates the Print menu at about 12 characters. */
  filename: string;
  description: string;
  available: boolean;
  /** Why it is not available, when it is not. */
  reason?: string;
}

const NOT_CONFIGURED_REASON = 'PLATE_Z_OFFSET_MM is not configured';

export class MagicFileError extends Error {
  readonly code: 'not-found' | 'not-configured';

  constructor(code: 'not-found' | 'not-configured', message: string) {
    super(message);
    this.code = code;
  }
}

function zoffFilename(offsetMm: number | undefined): string {
  // No offset to put in the name yet - fall back to something generic rather
  // than a filename that lies about what it contains.
  return offsetMm === undefined ? 'zoff.gcode' : `zoff-${offsetMm.toFixed(1)}mm.gcode`;
}

/** What GET /api/magic reports: what's on offer, and why not, when it isn't. */
export function listMagicFiles(config: Pick<Config, 'plateZOffsetMm'>): MagicFileEntry[] {
  const offset = config.plateZOffsetMm;
  return [
    {
      id: 'zoff',
      name: 'Z-offset',
      filename: zoffFilename(offset),
      description:
        offset === undefined ? 'Not configured' : `+${offset.toFixed(1)} mm on Elegoo defaults`,
      available: offset !== undefined,
      ...(offset === undefined ? { reason: NOT_CONFIGURED_REASON } : {}),
    },
    {
      id: 'reset',
      name: 'Reset Z-offset',
      filename: 'zoff-reset.gcode',
      description: 'Elegoo defaults',
      available: true,
    },
  ];
}

/** Generate the file for one entry. Throws MagicFileError if it can't be sent. */
export function buildMagicFile(
  id: string,
  config: Pick<Config, 'plateZOffsetMm'>,
): { filename: string; data: string } {
  if (id === 'reset') {
    return { filename: 'zoff-reset.gcode', data: generateZOffsetGcode(0) };
  }
  if (id === 'zoff') {
    const offset = config.plateZOffsetMm;
    if (offset === undefined) {
      throw new MagicFileError('not-configured', NOT_CONFIGURED_REASON);
    }
    return { filename: zoffFilename(offset), data: generateZOffsetGcode(offset) };
  }
  throw new MagicFileError('not-found', `Unknown magic file id: ${id}`);
}
