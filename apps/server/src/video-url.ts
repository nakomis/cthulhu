import { VideoAck, VideoStreamError } from '@cthulhu/sdcp';

export interface ResolveVideoUrlOptions {
  /** Sends Cmd 386 and returns the printer's RTSP URL. */
  enable: () => Promise<string>;
  /** The last URL the printer handed us, if any. */
  last: string | undefined;
  /** The printer's address, for the observed default URL. */
  address: string | undefined;
  onWarn?: (message: string) => void;
}

/**
 * Ask the printer for its RTSP URL, tolerating a wedged stream counter.
 *
 * Observed on the Mars 5 Ultra (firmware V1.5.0): the printer's count of
 * enabled streams can sit at MaximumVideoStreamAllowed (2) with nobody
 * watching, and then it refuses every Cmd 386 with Ack 1 - while its RTSP
 * server carries on serving video to anyone who asks. The count is only
 * bookkeeping, so on Ack 1 use the URL it gave last time, or the one it has
 * always given. Every other refusal (no camera, unknown error) still throws.
 */
export async function resolveVideoUrl(options: ResolveVideoUrlOptions): Promise<string> {
  try {
    return await options.enable();
  } catch (err) {
    if (!(err instanceof VideoStreamError) || err.ack !== VideoAck.ExceededMaxStreams) throw err;
    const url =
      options.last ?? (options.address ? `rtsp://${options.address}:554/video` : undefined);
    if (!url) throw err;
    options.onWarn?.(`${err.message}; trying ${url} anyway`);
    return url;
  }
}
