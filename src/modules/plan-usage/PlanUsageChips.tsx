import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { PlanUsageLimit } from '@/shared/types';

const REFRESH_MS = 120_000;

/** "in 3h 20m" / "in 6d" until a reset, or '' when unknown. */
export function formatReset(resetsAt: string | null, now = Date.now()): string {
  if (!resetsAt) return '';
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60_000));
  if (minutes >= 2880) return `in ${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `in ${minutes}m`;
}

/**
 * Remaining Claude and Antigravity allowance (weekly and five-hour). `refreshKey` changes when a turn ends, so the
 * numbers are asked for again right after you have used some.
 * Used by AgyChatPanel's header, PairPanel, and the chat module's cost popup.
 */
export default function PlanUsageChips({ refreshKey, className }: { refreshKey?: unknown; className?: string }) {
  // The latest limits the server reported; empty until the first answer or when agy cannot report.
  const [limits, setLimits] = useState<PlanUsageLimit[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await readApiJson<{ limits: PlanUsageLimit[] }>(await api.planUsage());
        if (!cancelled && Array.isArray(data.limits)) setLimits(data.limits);
      } catch {
        // Usage is a nicety; the chat works without it.
      }
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [refreshKey]);

  if (limits.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-2 text-xs text-muted-foreground ${className ?? ''}`} aria-label="Plan usage">
      {limits.map((limit) => {
        const tone = limit.remainingPercent <= 15 ? 'text-red-500' : limit.remainingPercent <= 40 ? 'text-amber-500' : 'text-emerald-500';
        return (
          <span key={`${limit.family}-${limit.window}`} className="rounded-md border border-border px-2 py-0.5" title={limit.resetsAt ? `Resets ${new Date(limit.resetsAt).toLocaleString()}` : undefined}>
            {limit.family} · {limit.window === 'weekly' ? 'week' : '5h'}: <b className={tone}>{limit.remainingPercent}%</b> left{limit.resetsAt ? ` · resets ${formatReset(limit.resetsAt)}` : ''}
          </span>
        );
      })}
    </div>
  );
}
