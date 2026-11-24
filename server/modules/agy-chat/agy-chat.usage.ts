/**
 * Reads Antigravity's own usage report (`agy -p=/usage`): how much of each model family's allowance is left.
 * Author: Josh Neufield (Archon Tech)
 */
import type { AgyUsageLimit } from '@/shared/types.js';

/**
 * Turns the tab-separated report ("Family<TAB>Weekly Limit Remaining<TAB>83%<TAB>2026-12-01T11:20:42Z") into limits.
 * Lines that do not look like that are skipped, so a changed report never breaks the page.
 * Used by agy-chat.module.ts for GET /usage and by tests/agy-chat.usage.test.ts.
 */
export function parseAgyUsage(output: string): AgyUsageLimit[] {
  const limits: AgyUsageLimit[] = [];
  for (const line of output.split('\n')) {
    const [family, label, percent, resetsAt] = line.split('\t').map((part) => part.trim());
    const match = /^(Weekly|Five Hour) Limit Remaining$/i.exec(label ?? '');
    const value = /^(\d{1,3})%$/.exec(percent ?? '');
    if (!family || !match || !value || Number(value[1]) > 100) continue;
    const resets = resetsAt && !Number.isNaN(Date.parse(resetsAt)) ? new Date(resetsAt).toISOString() : null;
    limits.push({ family, window: match[1].toLowerCase() === 'weekly' ? 'weekly' : 'five-hour', remainingPercent: Number(value[1]), resetsAt: resets });
  }
  return limits;
}
