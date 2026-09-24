export interface PrintableFile {
  /** Full path, as Cmd 128 takes it: /local/x.goo or /usb/Printing Test/x.goo. */
  path: string;
  /** The file's own name, for display. */
  name: string;
  storage: 'local' | 'usb';
  /** The folder it sits in, relative to the storage root; '' at the top. */
  folder: string;
}

interface Lister {
  listFiles(url?: string): Promise<Record<string, unknown>>;
}

interface Entry {
  name: string;
  /** 0 folder, 1 file, on the Mars 5 Ultra. */
  type: number | undefined;
}

const PRINTABLE = /\.(goo|ctb)$/i;
/** Windows litters every stick with this; it is never worth a request. */
const SKIP = new Set(['System Volume Information']);

async function entries(client: Lister, url: string): Promise<Entry[]> {
  const res = await client.listFiles(url);
  const data = (res.Data ?? res) as { Ack?: unknown; FileList?: unknown };
  if (data.Ack !== undefined && data.Ack !== 0) return [];
  if (!Array.isArray(data.FileList)) return [];
  return data.FileList.map((f: { name?: unknown; type?: unknown }) => ({
    // The printer doubles the slash for "/usb/" - normalise it away.
    name: String(f.name ?? '').replace(/\/{2,}/g, '/'),
    type: typeof f.type === 'number' ? f.type : undefined,
  }));
}

/**
 * Every printable file on the printer: internal storage, and the USB stick
 * a few folders deep. Elegoo's stick keeps its test prints in a folder, so a
 * flat listing of /usb shows nothing printable at all.
 */
export async function listPrintableFiles(
  client: Lister,
  { usbDepth = 3 }: { usbDepth?: number } = {},
): Promise<PrintableFile[]> {
  const found: PrintableFile[] = [];

  const walk = async (url: string, storage: PrintableFile['storage'], depth: number) => {
    for (const entry of await entries(client, url)) {
      // Only what lives under the folder asked for: a printer that answered
      // /usb with /local's files would otherwise list everything twice.
      if (entry.name.startsWith('/') && !entry.name.startsWith(`/${storage}/`)) continue;
      const base = entry.name.split('/').pop() ?? entry.name;
      if (entry.type === 0) {
        if (depth > 0 && !SKIP.has(base)) await walk(entry.name, storage, depth - 1);
        continue;
      }
      if (!PRINTABLE.test(base)) continue;
      const root = `/${storage}/`;
      const relative = entry.name.startsWith(root) ? entry.name.slice(root.length) : base;
      found.push({
        path: entry.name.startsWith('/') ? entry.name : `/local/${entry.name}`,
        name: base,
        storage,
        folder: relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '',
      });
    }
  };

  await walk('/local', 'local', 0);
  await walk('/usb', 'usb', usbDepth);
  return found;
}
