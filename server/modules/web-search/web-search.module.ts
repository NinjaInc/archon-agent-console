import { ollamaEnabled, ollamaInputBudgetChars, ollamaService } from '@/modules/ollama/index.js';

import { loadWebSearchConfig } from './web-search.config.js';
import { createPageFetcher } from './web-search.net.js';
import { createWebSearchRouter } from './web-search.routes.js';
import { createWebSearchService } from './web-search.service.js';

const config = loadWebSearchConfig(process.env);
if (config.problem) console.warn(`[web-search] search is off: ${config.problem}`);

const { fetchPage } = createPageFetcher();
const service = createWebSearchService({
  config,
  fetchPage,
  ollama: { enabled: ollamaEnabled, budgetChars: ollamaInputBudgetChars, ensureOnline: ollamaService.ensureOnline, streamChat: ollamaService.streamChat },
});

/** True when the search service answers its health check (and its address was accepted). */
async function searchOnline(): Promise<boolean> {
  if (config.problem) return false;
  try {
    const response = await fetch(`${config.searxngUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Web search router, assembled for the authenticated mount.
 * Used by server/index.ts, which mounts it at /api/search behind the passkey session check.
 */
export const webSearchRoutes = createWebSearchRouter(
  config.problem ? { ...service, search: async () => { throw new Error(config.problem); } } as typeof service : service,
  searchOnline,
);
