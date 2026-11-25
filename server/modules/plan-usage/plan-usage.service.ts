/**
 * Gathers both providers' remaining allowance, cached so pages can ask often without starting CLIs each time.
 * Author: Josh Neufield (Archon Tech)
 */
import type { PlanUsageLimit } from '@/shared/types.js';

import { parseAgyUsage, parseClaudeUsage } from './plan-usage.parse.js';

const CACHE_MS = 60_000;

type Options = {
  /** Each returns the raw report text of its CLI and may throw. */
  runClaude: () => Promise<string>;
  runAgy: () => Promise<string>;
  now?: () => number;
};

/**
 * `list()` returns Claude's limits then Antigravity's; a provider that cannot answer is simply absent.
 * Used by plan-usage.module.ts and tests/plan-usage.service.test.ts.
 */
export function createPlanUsageService({ runClaude, runAgy, now = Date.now }: Options) {
  let cached: { at: number; value: Promise<PlanUsageLimit[]> } | null = null;
  const gather = async (): Promise<PlanUsageLimit[]> => {
    const [claude, agy] = await Promise.all([
      runClaude().then((text) => parseClaudeUsage(text, now())).catch(() => []),
      runAgy().then(parseAgyUsage).catch(() => []),
    ]);
    return [...claude, ...agy];
  };
  function list(): Promise<PlanUsageLimit[]> {
    // The promise is cached, so requests arriving together share one pair of CLI runs.
    if (!cached || now() - cached.at >= CACHE_MS) cached = { at: now(), value: gather() };
    return cached.value;
  }
  return { list };
}
