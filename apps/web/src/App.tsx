import { printStatusLabel } from './status.js';

export interface AppProps {
  /** Placeholder until the server's WebSocket feed lands in CTHU-4. */
  statusCode?: number;
}

export function App({ statusCode = 0 }: AppProps) {
  return (
    <main className="min-h-dvh bg-abyss text-slate-100 p-4">
      <h1 className="text-2xl font-semibold tracking-tight text-tentacle">Cthulhu</h1>
      <p className="mt-1 text-sm text-slate-400">Elegoo Mars 5 Ultra</p>
      <section className="mt-6 rounded-lg border border-slate-700 p-4">
        <h2 className="text-xs uppercase tracking-wider text-slate-400">Status</h2>
        <p className="mt-1 text-xl">{printStatusLabel(statusCode)}</p>
      </section>
    </main>
  );
}
