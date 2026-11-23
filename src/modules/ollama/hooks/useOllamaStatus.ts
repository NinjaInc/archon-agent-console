import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

export type OllamaHealth = 'unknown' | 'online' | 'offline';

export type OllamaStatus = {
  /** False until the server says the local model is set up; the tab stays hidden until then. */
  configured: boolean;
  status: OllamaHealth;
  model: string;
  models: Array<{ name: string; parameterSize?: string }>;
  numCtx: number;
  checkedAt: number | null;
};

const EMPTY: OllamaStatus = { configured: false, status: 'unknown', model: '', models: [], numCtx: 8192, checkedAt: null };

/** The same cadence the server polls at. The server answers from its own cached check, so this is cheap. */
export const STATUS_POLL_MS = 30_000;

/**
 * Whether the local model is set up and reachable. Polls every 30 s while the page is visible (a hidden tab does not
 * keep asking), and `refresh()` forces a live check, for the "Check again" button.
 */
export function useOllamaStatus(): OllamaStatus & { refresh: () => Promise<void> } {
  // The last status the server reported (configured, up or down, models); polled so the tab and its dot stay current.
  const [state, setState] = useState<OllamaStatus>(EMPTY);
  // True after unmount, so a late response does not set state on a gone component.
  const cancelled = useRef(false);

  const load = useCallback(async (fresh: boolean) => {
    try {
      const data = await readApiJson<Partial<OllamaStatus>>(await api.ollama.status(fresh));
      if (cancelled.current) return;
      setState({
        configured: data.configured === true,
        status: data.status === 'online' || data.status === 'offline' ? data.status : 'unknown',
        model: data.model ?? '',
        models: Array.isArray(data.models) ? data.models : [],
        numCtx: data.numCtx ?? 8192,
        checkedAt: data.checkedAt ?? null,
      });
    } catch {
      // Signed out or the console itself is unreachable: leave the last known state, the tab hides if it was never configured.
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void load(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(false);
    }, STATUS_POLL_MS);
    return () => {
      cancelled.current = true;
      window.clearInterval(timer);
    };
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);
  return { ...state, refresh };
}
