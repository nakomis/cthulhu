import { useCallback, useEffect, useState } from 'react';
import { api, type MagicFileEntry } from './api.js';

export interface MagicFilesProps {
  /** Injected in tests. */
  listMagicFiles?: () => Promise<MagicFileEntry[]>;
  sendMagicFile?: (id: string) => Promise<{ filename: string; size: number }>;
}

/**
 * Magic Files: small config gcode files that fix known printer quirks - a
 * magnetic flex build plate trips the pre-print "Foreign Material Detected"
 * check, and raising six firmware thresholds by the plate's thickness fixes
 * it. See CTHU-30 and the README's "What the real printer taught us".
 *
 * Unlike Files, there is no Upload and no Delete here: these files are
 * server-generated, not user-supplied, and there is nothing on the printer
 * to delete - they never show up in its own file list (see below). Sending
 * one changes nothing on the printer by itself, so there is no two-click
 * confirm either: the touchscreen tap that actually runs it is the commit.
 */
export function MagicFiles({
  listMagicFiles = api.magicFiles,
  sendMagicFile = api.sendMagicFile,
}: MagicFilesProps) {
  const [entries, setEntries] = useState<MagicFileEntry[]>([]);
  const [message, setMessage] = useState<string | undefined>();
  /** The id currently sending, if any - disables every row's button, not just its own. */
  const [sendingId, setSendingId] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      setEntries(await listMagicFiles());
    } catch {
      setEntries([]);
    }
  }, [listMagicFiles]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSend = async (entry: MagicFileEntry) => {
    setSendingId(entry.id);
    setMessage(`Sending ${entry.filename}…`);
    try {
      const result = await sendMagicFile(entry.id);
      // zoff-3.2mm.gcode -> zoff-3.2mm, which is what the touchscreen's Print
      // menu shows (it truncates the extension, and the whole name past
      // about 12 characters).
      const label = result.filename.replace(/\.gcode$/, '');
      setMessage(
        `Sent ${result.filename}. On the printer: Print → ${label} → then power-cycle. ` +
          'If this changes the settings, the printer will ask for region and Wi-Fi again ' +
          "when it restarts. It won't appear in the network file list - only on the " +
          'touchscreen.',
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingId(undefined);
    }
  };

  // Nothing to show before the first successful list, and nothing wrong with
  // that: a printer that is off is normal, same as Files.
  if (entries.length === 0) return null;

  return (
    <section className="rounded-lg border border-slate-700 p-4">
      <h2 className="text-xs uppercase tracking-wider text-slate-400">Magic Files</h2>

      {message ? (
        <p role="status" className="mt-2 text-sm text-slate-300">
          {message}
        </p>
      ) : null}

      <ul className="mt-3 space-y-2">
        {entries.map((entry) => {
          const detail = entry.available ? entry.description : (entry.reason ?? entry.description);
          const sending = sendingId === entry.id;
          return (
            <li key={entry.id} className="flex items-center justify-between gap-3">
              <MagicIcon />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{entry.name}</span>
                <span className="block truncate text-xs text-slate-500">
                  {entry.filename}
                  {detail ? ` · ${detail}` : ''}
                </span>
              </span>
              <button
                type="button"
                disabled={!entry.available || sendingId !== undefined}
                title={!entry.available ? entry.reason : undefined}
                onClick={() => void onSend(entry)}
                className="shrink-0 rounded border border-tentacle/50 px-3 py-1 text-sm text-tentacle disabled:opacity-40"
              >
                {sending ? 'Sending…' : 'Send to printer'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * A tentacle holding a wand over a file, in the app icon's green-on-navy, so
 * the box reads as cthulhu's own rather than a generic sparkle. Decorative:
 * each row's name already says what it is. Source at docs/icons/magic-files-1024.png.
 */
function MagicIcon() {
  return (
    <img
      src="/magic-files-96.png"
      alt=""
      aria-hidden="true"
      className="size-12 shrink-0 rounded bg-black object-contain"
    />
  );
}
