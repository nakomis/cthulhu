import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Preview PNGs for files uploaded through cthulhu, one per file name.
 *
 * The printer has no command to send a file back, so a preview can only be
 * taken on the way in: files put on the printer any other way - the USB
 * stick, the Elegoo app - have none.
 */
export class PreviewStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  save(filename: string, png: Buffer): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.fileFor(filename), png);
  }

  load(filename: string): Buffer | undefined {
    try {
      return readFileSync(this.fileFor(filename));
    } catch {
      return undefined;
    }
  }

  /** By base name only, so no path the browser sends can leave the folder. */
  private fileFor(filename: string): string {
    const base = filename.split(/[\\/]/).pop() ?? '';
    const safe = base.replace(/[^\w. -]/g, '_').replace(/^\.+/, '_');
    return join(this.dir, `${safe || '_'}.png`);
  }
}
