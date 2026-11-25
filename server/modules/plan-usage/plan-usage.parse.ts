/**
 * Parsers for the usage reports of both agent CLIs (`claude -p /usage` and `agy -p=/usage`).
 * Author: Josh Neufield (Archon Tech)
 *
 * Lines that do not look as expected are skipped, so a changed report never breaks the page.
 */
import type { PlanUsageLimit } from '@/shared/types.js';

/**
 * Tab-separated Antigravity report: "Family<TAB>Weekly Limit Remaining<TAB>83%<TAB>2026-12-01T11:20:42Z".
 * Used by plan-usage.service.ts and tests/plan-usage.parse.test.ts.
 */
export function parseAgyUsage(output: string): PlanUsageLimit[] {
  const limits: PlanUsageLimit[] = [];
  for (const line of output.split('\n')) {
    const [family, label, percent, resetsAt] = line.split('\t').map((part) => part.trim());
    const match = /^(Weekly|Five Hour) Limit Remaining$/i.exec(label ?? '');
    const value = /^(\d{1,3})%$/.exec(percent ?? '');
    if (!family || !match || !value || Number(value[1]) > 100) continue;
    const resets = resetsAt && !Number.isNaN(Date.parse(resetsAt)) ? new Date(resetsAt).toISOString() : null;
    limits.push({ provider: 'agy', family, window: match[1].toLowerCase() === 'weekly' ? 'weekly' : 'five-hour', remainingPercent: Number(value[1]), resetsAt: resets });
  }
  return limits;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Nov 25, 8:39am (UTC)" -> ISO time. The report has no year, so the nearest upcoming one is used. Other zones give null. */
function claudeReset(text: string, now: number): string | null {
  const match = /^([A-Z][a-z]{2}) (\d{1,2}),? (?:at )?(\d{1,2})(?::(\d{2}))?\s?(am|pm) \(UTC\)$/i.exec(text.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month < 0) return null;
  const hour = (Number(match[3]) % 12) + (match[5].toLowerCase() === 'pm' ? 12 : 0);
  const year = new Date(now).getUTCFullYear();
  let at = Date.UTC(year, month, Number(match[2]), hour, Number(match[4] ?? 0));
  if (at < now - 2 * 86_400_000) at = Date.UTC(year + 1, month, Number(match[2]), hour, Number(match[4] ?? 0));
  return new Date(at).toISOString();
}

/**
 * Claude's report: "Current week (all models): 4% used · resets Dec 1, 9:59pm (UTC)". Percentages are turned into
 * "remaining" so both providers read the same way.
 * Used by plan-usage.service.ts and tests/plan-usage.parse.test.ts.
 */
export function parseClaudeUsage(output: string, now = Date.now()): PlanUsageLimit[] {
  const limits: PlanUsageLimit[] = [];
  for (const line of output.split('\n')) {
    const match = /^Current (session|week)(?: \(([^)]{1,40})\))?: (\d{1,3})% used(?: · resets (.+))?$/.exec(line.trim());
    if (!match || Number(match[3]) > 100) continue;
    const scope = match[2] && match[2] !== 'all models' ? ` (${match[2]})` : '';
    limits.push({
      provider: 'claude',
      family: `Claude${scope}`,
      window: match[1] === 'week' ? 'weekly' : 'five-hour',
      remainingPercent: 100 - Number(match[3]),
      resetsAt: match[4] ? claudeReset(match[4], now) : null,
    });
  }
  return limits;
}
