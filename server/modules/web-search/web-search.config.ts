/**
 * Settings for Web search, read once from the environment.
 * Author: Josh Neufield (Archon Tech)
 *
 * The search engine is a SearXNG instance this machine runs for itself (scripts/install-searxng.sh), on loopback.
 * SEARXNG_URL may point at another private host on the LAN, never at a public one: queries and the keys in the
 * settings must not leave the network except through the engines SearXNG itself talks to.
 */
import type { WebSearchConfig } from '@/shared/types.js';
import { isPrivateHost } from '@/shared/utils.js';

const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8888';

/**
 * Reads SEARXNG_URL and returns the web search settings. A bad value never stops the console from starting: the result carries a
 * `problem` and the safe default address instead.
 * Used by web-search.module.ts at startup and by scripts/search-mcp.mjs (through the compiled build) for the agent tools.
 */
export function loadWebSearchConfig(env: NodeJS.ProcessEnv = process.env): WebSearchConfig {
  const config: WebSearchConfig = { searxngUrl: DEFAULT_SEARXNG_URL, searchTimeoutMs: 15_000, maxSources: 4 };
  const raw = (env.SEARXNG_URL ?? '').trim();
  if (raw !== '') {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') config.problem = 'SEARXNG_URL must start with http:// or https://';
      else if (url.username || url.password) config.problem = 'SEARXNG_URL must not contain a user name or password';
      else if (!isPrivateHost(url.hostname)) config.problem = 'SEARXNG_URL must be on this machine or a private network';
      else config.searxngUrl = url.origin;
    } catch {
      config.problem = 'SEARXNG_URL is not a valid URL';
    }
  }
  return config;
}
