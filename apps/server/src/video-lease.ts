/**
 * The printer's video stream, reference-counted.
 *
 * Browsers watching and a time-lapse recording both need the stream on, and
 * the printer counts every Cmd 386 enable against its limit - it stuck at
 * 2 of 2 when enables and disables did not pair up. So: one enable when the
 * first user arrives, one disable when the last leaves, whoever they are.
 * Without this, the last browser closing would turn the stream off under a
 * time-lapse still recording.
 */
export class VideoLease {
  private holders = 0;
  private readonly setStream: (on: boolean) => Promise<unknown>;

  constructor(setStream: (on: boolean) => Promise<unknown>) {
    this.setStream = setStream;
  }

  get count(): number {
    return this.holders;
  }

  async acquire(): Promise<void> {
    this.holders += 1;
    if (this.holders === 1) await this.setStream(true).catch(() => {});
  }

  async release(): Promise<void> {
    if (this.holders === 0) return;
    this.holders -= 1;
    if (this.holders === 0) await this.setStream(false).catch(() => {});
  }
}
