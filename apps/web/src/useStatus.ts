import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type PrinterView } from './api.js';

export interface UseStatusOptions {
  /** Injected in tests. */
  fetchStatus?: () => Promise<PrinterView>;
  /** Fallback poll interval, used only when the socket is not connected. */
  pollMs?: number;
  /** Injected in tests so no real socket is opened. */
  socketFactory?: (url: string) => WebSocket;
}

export interface UseStatusResult {
  view: PrinterView | undefined;
  error: string | undefined;
  /** True when live updates are arriving by push rather than polling. */
  live: boolean;
  refresh: () => Promise<void>;
}

function wsUrl(): string {
  const proto = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${globalThis.location?.host ?? ''}/api/ws`;
}

/**
 * Live printer state.
 *
 * Prefers the WebSocket, because the printer already pushes to the server and
 * polling just reintroduces latency we had removed. Falls back to polling when
 * the socket is not available - which is not hypothetical: a proxy that does
 * not pass Upgrade would otherwise leave the dashboard permanently blank, and
 * a blank dashboard is much worse than a slightly stale one.
 */
export function useStatus(options: UseStatusOptions = {}): UseStatusResult {
  const { fetchStatus = api.status, pollMs = 2000, socketFactory } = options;
  const [view, setView] = useState<PrinterView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [live, setLive] = useState(false);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  // A ref, not the state: the guard below is read inside an async callback
  // that closed over an older render.
  const liveRef = useRef(false);

  // Stable so the effect below can declare it as a dependency without
  // re-subscribing the socket on every render.
  const refresh = useCallback(async () => {
    try {
      const fetched = await fetchStatus();
      // A poll started BEFORE the socket opened can resolve AFTER a pushed
      // frame and clobber it with staler data. Once push is live, polled
      // results are always the older of the two, so drop them.
      if (liveRef.current) return;
      setView(fetched);
      setError(undefined);
    } catch (err) {
      if (liveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fetchStatus]);

  useEffect(() => {
    let closed = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const startPolling = () => {
      if (poll) return;
      void refresh();
      poll = setInterval(() => void refresh(), pollMs);
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = undefined;
    };

    const connect = () => {
      if (closed) return;
      let socket: WebSocket;
      try {
        socket = socketFactory ? socketFactory(wsUrl()) : new WebSocket(wsUrl());
      } catch {
        startPolling();
        return;
      }
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        liveRef.current = true;
        setLive(true);
        setError(undefined);
        // The server sends a snapshot on connect, so polling is redundant now.
        stopPolling();
      });

      socket.addEventListener('message', (ev: MessageEvent) => {
        try {
          setView(JSON.parse(String(ev.data)) as PrinterView);
          setError(undefined);
        } catch {
          // A malformed frame is not worth blanking the dashboard over.
        }
      });

      const fallBack = () => {
        liveRef.current = false;
        setLive(false);
        socketRef.current = undefined;
        if (closed) return;
        startPolling();
        // Reconnect, but keep polling in the meantime so the UI stays current.
        retry = setTimeout(connect, 3000);
      };
      socket.addEventListener('close', fallBack);
      socket.addEventListener('error', fallBack);
    };

    // Poll immediately so there is data on screen before the socket opens.
    startPolling();
    connect();

    return () => {
      closed = true;
      stopPolling();
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
    };
  }, [refresh, pollMs, socketFactory]);

  return { view, error, live, refresh };
}
