import { describe, expect, it } from 'vitest';
import { HEADER_BYTES, parseGooHeader } from './header.js';
import { decodeLayer, indexLayers, LayerDecodeError } from './layers.js';
import { syntheticGoo } from './synthetic.js';

const W = 200;
const H = 100;
/** Layer 0: the left half lit. Layer 1: a 40 x 20 block at (100, 40). Layer 2: nothing. */
const file = syntheticGoo({
  width: W,
  height: H,
  layers: [(x) => x < 100, (x, y) => x >= 100 && x < 140 && y >= 40 && y < 60, () => false],
  printTimeS: 5300,
});
const read = async (offset: number, length: number) => file.subarray(offset, offset + length);

describe('the .goo header', () => {
  it('reads the settings a real file carries', () => {
    const header = parseGooHeader(file.subarray(0, HEADER_BYTES));
    expect(header).toMatchObject({
      machineName: 'ELEGOO Mars 5 Ultra',
      layerCount: 3,
      resolutionX: W,
      resolutionY: H,
      layerHeightMm: 0.05,
      exposureS: 2.5,
      printTimeS: 5300,
    });
  });

  it('declines a file that is not a .goo', () => {
    expect(parseGooHeader(Buffer.from('CTB-ish rubbish'.repeat(20_000)))).toBeUndefined();
  });
});

describe('layers', () => {
  const header = parseGooHeader(file.subarray(0, HEADER_BYTES));
  if (!header) throw new Error('header');

  it('indexes every layer from the address in the header', async () => {
    const refs = await indexLayers(read, header);
    expect(refs.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('decodes a layer exactly, at full size', async () => {
    const [, ref] = await indexLayers(read, header);
    const img = decodeLayer(await read(ref?.offset ?? 0, ref?.size ?? 0), {
      width: W,
      height: H,
      scale: 1,
    });
    const at = (x: number, y: number) => img.data[y * W + x];
    expect(at(100, 40)).toBe(255);
    expect(at(139, 59)).toBe(255);
    expect(at(99, 40)).toBe(0);
    expect(at(140, 59)).toBe(0);
    expect(img.data.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(40 * 20);
  });

  it('averages when scaling down, so a half-lit cell is mid-grey', async () => {
    const [ref] = await indexLayers(read, header);
    // Scale 8 puts x 96..103 in one cell: 4 lit, 4 dark.
    const img = decodeLayer(await read(ref?.offset ?? 0, ref?.size ?? 0), {
      width: W,
      height: H,
      scale: 8,
    });
    expect(img.width).toBe(25);
    expect(img.height).toBe(13);
    expect(img.data[0]).toBe(255);
    expect(img.data[12]).toBe(128);
    expect(img.data[13]).toBe(0);
  });

  it('refuses a layer whose checksum does not match', async () => {
    const [ref] = await indexLayers(read, header);
    const data = Buffer.from(await read(ref?.offset ?? 0, ref?.size ?? 0));
    data[3] = (data[3] ?? 0) ^ 0x01;
    expect(() => decodeLayer(data, { width: W, height: H, scale: 1 })).toThrow(LayerDecodeError);
  });

  it('refuses a layer that decodes to the wrong number of pixels', async () => {
    const [ref] = await indexLayers(read, header);
    const data = await read(ref?.offset ?? 0, ref?.size ?? 0);
    // The same data, told the image is a row taller than it is.
    expect(() => decodeLayer(data, { width: W, height: H + 1, scale: 1 })).toThrow(/pixels/);
  });
});
