/**
 * The printer's own web server, on the upload port (3030): an embedded
 * Mongoose that serves its filesystem by path, with Range support. Not in
 * the SDCP spec; found by following the Thumbnail URL that Cmd 321 returns.
 *
 *   /media/mmcblk0p3/<name>                  internal storage - SDCP's /local
 *   /media/sda1/<path>                       the USB stick - SDCP's /usb
 *   /media/mmcblk0p1/history_image/<task>.bmp  a task's 400x300 thumbnail
 *
 * It serves everything else on those partitions too, unauthenticated -
 * including the printer's WiFi password in plain text. Nothing here reads
 * anything but print files and thumbnails.
 */
const LOCAL_ROOT = '/media/mmcblk0p3';
const USB_ROOT = '/media/sda1';

/** SDCP path (/local/x.goo, /usb/dir/x.goo) or task path to the printer's own. */
export function mediaPath(path: string): string {
  const clean = path.replace(/\/{2,}/g, '/');
  if (clean.startsWith('/media/')) return clean;
  if (clean.startsWith('/local/')) return `${LOCAL_ROOT}/${clean.slice('/local/'.length)}`;
  if (clean.startsWith('/usb/')) return `${USB_ROOT}/${clean.slice('/usb/'.length)}`;
  // The spec: no leading "/" means /local.
  return `${LOCAL_ROOT}/${clean.replace(/^\//, '')}`;
}

/** The printer's own path back to SDCP's, for display and for Cmd 128. */
export function sdcpPath(media: string): string {
  const clean = media.replace(/\/{2,}/g, '/');
  if (clean.startsWith(`${LOCAL_ROOT}/`)) return `/local/${clean.slice(LOCAL_ROOT.length + 1)}`;
  if (clean.startsWith(`${USB_ROOT}/`)) return `/usb/${clean.slice(USB_ROOT.length + 1)}`;
  return clean;
}

/** Only print files, and only on the two storage roots - never anything else. */
export function isPrintFile(media: string): boolean {
  return (
    (media.startsWith(`${LOCAL_ROOT}/`) || media.startsWith(`${USB_ROOT}/`)) &&
    !media.split('/').includes('..') &&
    /\.(goo|ctb)$/i.test(media)
  );
}

export function mediaUrl(address: string, port: number, media: string): string {
  return `http://${address}:${port}${media.split('/').map(encodeURIComponent).join('/')}`;
}
