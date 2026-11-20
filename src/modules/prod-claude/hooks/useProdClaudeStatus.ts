import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

export type ProdClaudeStatus = { configured: boolean; ready?: boolean; label?: string; host?: string; user?: string };

/** Asks the server once whether the Prod Claude terminal is set up; the tab is hidden until it is. */
export function useProdClaudeStatus(): ProdClaudeStatus {
  const [status, setStatus] = useState<ProdClaudeStatus>({ configured: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await readApiJson<ProdClaudeStatus>(await api.prodClaude.status());
        if (!cancelled) setStatus(data);
      } catch {
        // Not configured, signed out or offline: the tab stays hidden.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return status;
}
