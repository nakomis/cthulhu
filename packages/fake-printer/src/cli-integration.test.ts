import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePrinter, type FakePrinter } from './server.js';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '../../sdcp/dist/cli.js');

let printer: FakePrinter;
let dir: string;

beforeEach(async () => {
  printer = await createFakePrinter({ discovery: false, statusIntervalMs: 60, msPerLayer: 30 });
  dir = mkdtempSync(join(tmpdir(), 'cthulhu-cli-'));
});

afterEach(async () => {
  await printer.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('cthulhu-sdcp status', () => {
  it('prints live status from a printer', async () => {
    // The acceptance criterion for CTHU-2, exercised against the fake.
    const { stdout } = await run('node', [
      CLI,
      'status',
      '--ip',
      '127.0.0.1',
      '--port',
      String(printer.wsPort),
    ]);
    expect(stdout).toContain('connecting to 127.0.0.1');
    expect(stdout).toMatch(/status=\d+\s+layer=\d+\/\d+/);
  }, 20_000);

  it('prints the attributes, including the machine name', async () => {
    const { stdout } = await run('node', [
      CLI,
      'status',
      '--ip',
      '127.0.0.1',
      '--port',
      String(printer.wsPort),
    ]);
    expect(stdout).toContain('Mars 5 Ultra');
  }, 20_000);

  it('--raw emits the untouched frame, so nothing is lost to formatting', async () => {
    const { stdout } = await run('node', [
      CLI,
      'status',
      '--ip',
      '127.0.0.1',
      '--port',
      String(printer.wsPort),
      '--raw',
    ]);
    const jsonLine = stdout.split('\n').find((l) => l.startsWith('{'));
    expect(jsonLine).toBeDefined();
    // The misspelling must survive all the way to the operator's terminal.
    expect(JSON.stringify(JSON.parse(jsonLine as string))).toContain('RelaseFilmState');
  }, 20_000);
});

describe('cthulhu-sdcp --record', () => {
  it('captures raw frames as JSON Lines', async () => {
    // This is the tool for CTHU-2's real job: recording what the machine
    // actually sends, before anyone writes a parser against FDM documentation.
    const path = join(dir, 'capture.jsonl');
    await run('node', [
      CLI,
      'status',
      '--ip',
      '127.0.0.1',
      '--port',
      String(printer.wsPort),
      '--record',
      path,
    ]);

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const parsed = lines.map((l) => JSON.parse(l) as { at: string; kind: string; frame: unknown });
    expect(parsed.map((p) => p.kind)).toContain('attributes');
    expect(parsed.map((p) => p.kind)).toContain('status');
    // Every line stands alone, so a three-hour print survives a Ctrl-C.
    for (const p of parsed) {
      expect(p.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(p.frame).toBeTypeOf('object');
    }
  }, 20_000);

  it('records the frame VERBATIM, misspellings and all', async () => {
    const path = join(dir, 'verbatim.jsonl');
    await run('node', [
      CLI,
      'status',
      '--ip',
      '127.0.0.1',
      '--port',
      String(printer.wsPort),
      '--record',
      path,
    ]);
    const raw = readFileSync(path, 'utf8');
    // If the recorder ever "tidied" these, the capture would be useless as a
    // fixture - it would no longer be what the printer sent.
    expect(raw).toContain('RelaseFilmState');
    expect(raw).toContain('CurrenCoord');
  }, 20_000);
});

describe('cthulhu-sdcp discover', () => {
  it('exits non-zero and points at --ip when nothing answers', async () => {
    // Broadcast does not cross subnets and Docker bridge networking eats it,
    // so "not found" must suggest the pinned-IP route rather than dead-end.
    //
    // Aimed at TEST-NET-1 (RFC 5737), where nothing can answer. Plain
    // broadcast stopped working as "nothing" the day a real printer joined
    // the LAN.
    await expect(
      run('node', [CLI, 'discover', '--timeout', '400', '--broadcast', '192.0.2.255']),
    ).rejects.toMatchObject({ code: 1 });
  }, 20_000);
});
