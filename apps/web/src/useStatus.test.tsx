import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PrinterView } from './api.js';
import { useStatus } from './useStatus.js';

const view = (over: Partial<PrinterView> = {}): PrinterView => ({
  connected: true,
  address: '172.29.0.50',
  mainboardId: 'mb',
  machineStatus: [1],
  print: {
    status: 3,
    statusLabel: 'Exposing',
    filename: 'a.goo',
    currentLayer: 1,
    totalLayer: 10,
    progressPercent: 10,
    remainingMs: 1000,
    errorNumber: 0,
    taskId: 't',
  },
  releaseFilmState: 1,
  attributes: {},
  updatedAt: new Date().toISOString(),
  ...over,
});

/** A socket stub we can drive by hand. */
function fakeSocket() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const socket = {
    readyState: 1,
    close: vi.fn(),
    addEventListener: (t: string, cb: (e: unknown) => void) => {
      listeners[t] ??= [];
      listeners[t]?.push(cb);
    },
  };
  const fire = (t: string, e?: unknown) => {
    for (const cb of listeners[t] ?? []) cb(e);
  };
  return { socket: socket as unknown as WebSocket, fire };
}

describe('useStatus', () => {
  it('polls immediately, so there is data before the socket opens', async () => {
    const fetchStatus = vi.fn().mockResolvedValue(view());
    const { socket } = fakeSocket();
    const { result } = renderHook(() =>
      useStatus({ fetchStatus, pollMs: 100_000, socketFactory: () => socket }),
    );
    await waitFor(() => expect(result.current.view).toBeDefined());
    expect(fetchStatus).toHaveBeenCalled();
    expect(result.current.live).toBe(false);
  });

  it('goes live and applies pushed frames', async () => {
    const fetchStatus = vi.fn().mockResolvedValue(view());
    const { socket, fire } = fakeSocket();
    const { result } = renderHook(() =>
      useStatus({ fetchStatus, pollMs: 100_000, socketFactory: () => socket }),
    );

    fire('open');
    await waitFor(() => expect(result.current.live).toBe(true));

    fire('message', { data: JSON.stringify(view({ connected: false })) });
    await waitFor(() => expect(result.current.view?.connected).toBe(false));
  });

  it('falls back to polling when the socket closes', async () => {
    // Not hypothetical: a proxy that does not pass Upgrade would otherwise
    // leave the dashboard permanently blank, which is far worse than stale.
    const fetchStatus = vi.fn().mockResolvedValue(view());
    const { socket, fire } = fakeSocket();
    const { result } = renderHook(() =>
      useStatus({ fetchStatus, pollMs: 100_000, socketFactory: () => socket }),
    );
    fire('open');
    await waitFor(() => expect(result.current.live).toBe(true));

    fire('close');
    await waitFor(() => expect(result.current.live).toBe(false));
  });

  it('survives a malformed frame rather than blanking the dashboard', async () => {
    const fetchStatus = vi.fn().mockResolvedValue(view());
    const { socket, fire } = fakeSocket();
    const { result } = renderHook(() =>
      useStatus({ fetchStatus, pollMs: 100_000, socketFactory: () => socket }),
    );
    fire('open');
    // The server sends a snapshot immediately on connect, so that is what
    // populates the view in practice - not the poll, which is now suppressed.
    fire('message', { data: JSON.stringify(view()) });
    await waitFor(() => expect(result.current.view).toBeDefined());

    fire('message', { data: 'not json{' });
    expect(result.current.view).toBeDefined();
    expect(result.current.view?.print.statusLabel).toBe('Exposing');
  });

  it('falls back to polling if the socket cannot even be constructed', async () => {
    const fetchStatus = vi.fn().mockResolvedValue(view());
    const { result } = renderHook(() =>
      useStatus({
        fetchStatus,
        pollMs: 100_000,
        socketFactory: () => {
          throw new Error('no websocket here');
        },
      }),
    );
    await waitFor(() => expect(result.current.view).toBeDefined());
    expect(result.current.live).toBe(false);
  });
});
