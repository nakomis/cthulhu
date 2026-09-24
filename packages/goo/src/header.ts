/**
 * The .goo header, as far as cthulhu needs it.
 *
 * Mapped against a file sliced for the Mars 5 Ultra, whose true values were
 * known (893 layers, 0.05 mm, 2.5 s, 2 bottom layers at 32 s, 5300 s): all
 * big-endian. "V3.0", an 8-byte magic, six fixed-width strings, three u16
 * settings (194 bytes), a 116x116 and a 290x290 RGB565 preview each followed
 * by "\r\n", then the print settings below. The header records where the
 * first layer starts, so nothing depends on knowing its full length.
 */
export const GOO_MAGIC = Uint8Array.from([0x07, 0x00, 0x00, 0x00, 0x44, 0x4c, 0x50, 0x00]);
export const SMALL_PREVIEW = { width: 116, height: 116 } as const;
export const BIG_PREVIEW = { width: 290, height: 290 } as const;

/** Where each part of the header starts. */
export const OFFSETS = (() => {
  const smallPreview = 194;
  const bigPreview = smallPreview + SMALL_PREVIEW.width * SMALL_PREVIEW.height * 2 + 2;
  const settings = bigPreview + BIG_PREVIEW.width * BIG_PREVIEW.height * 2 + 2;
  return { smallPreview, bigPreview, settings };
})();

/** Enough bytes to parse the header and both previews: fetch this much. */
export const HEADER_BYTES = OFFSETS.settings + 176;

export interface GooHeader {
  machineName: string;
  layerCount: number;
  resolutionX: number;
  resolutionY: number;
  /** The LCD image is mirrored left-to-right relative to the build plate. */
  mirrorX: boolean;
  mirrorY: boolean;
  layerHeightMm: number;
  exposureS: number;
  bottomExposureS: number;
  bottomLayerCount: number;
  /** The slicer's estimate. The printer's own, from TotalTicks, is usually longer. */
  printTimeS: number;
  /** Byte offset of the first layer's definition. */
  layerTableOffset: number;
}

export function isGoo(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const version = String.fromCharCode(...data.subarray(0, 4));
  return version === 'V3.0' && GOO_MAGIC.every((b, i) => data[4 + i] === b);
}

export function parseGooHeader(data: Uint8Array): GooHeader | undefined {
  if (!isGoo(data) || data.length < HEADER_BYTES) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const s = OFFSETS.settings;
  const text = (start: number, length: number) =>
    String.fromCharCode(...data.subarray(start, start + length)).replace(/\0.*$/s, '');

  const header: GooHeader = {
    // After "V3.0", the magic, software (32), its version (24) and file time
    // (24): the printer name.
    machineName: text(4 + 8 + 32 + 24 + 24, 32),
    layerCount: view.getUint32(s),
    resolutionX: view.getUint16(s + 4),
    resolutionY: view.getUint16(s + 6),
    mirrorX: data[s + 8] === 1,
    mirrorY: data[s + 9] === 1,
    layerHeightMm: round(view.getFloat32(s + 22)),
    exposureS: round(view.getFloat32(s + 26)),
    bottomExposureS: round(view.getFloat32(s + 59)),
    bottomLayerCount: view.getUint32(s + 63),
    printTimeS: view.getUint32(s + 136),
    layerTableOffset: view.getUint32(s + 160),
  };
  // A header that does not make sense is a format this does not understand.
  if (
    header.layerCount === 0 ||
    header.resolutionX === 0 ||
    header.resolutionY === 0 ||
    header.layerTableOffset < s
  ) {
    return undefined;
  }
  return header;
}

/** float32 noise off: 0.05000000074505806 is 0.05. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
