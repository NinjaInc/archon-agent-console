import { AlertCircle, Check, Loader2 } from 'lucide-react';

import type { PairRun, PairStatus } from '@/shared/types';
import { cn } from '@/shared/utils';

const PAIR_STEPS = ['Plan', 'Edit', 'Approve change', 'Test', 'Review', 'Done'] as const;

type StepVisualState = 'pending' | 'working' | 'waiting' | 'completed' | 'failed' | 'discarded';

type PairStepIndicatorProps = {
  /** Currently open Pair run, or null when the user is filling out the new-task form. */
  run: PairRun | null;
};

function inferStoppedStepIndex(run: PairRun): number {
  if (run.verdict) return 5;
  if (run.review) return 4;
  if (run.tests) return 3;
  if (run.diff) return 2;
  if (run.plan && run.agentNotes) return 1;
  return 0;
}

function resolveStepProgress(run: PairRun | null): { activeIndex: number; activeState: StepVisualState } {
  if (!run) {
    return { activeIndex: -1, activeState: 'pending' };
  }

  const byStatus: Partial<Record<PairStatus, { activeIndex: number; activeState: StepVisualState }>> = {
    planning: { activeIndex: 0, activeState: 'working' },
    'plan-ready': { activeIndex: 0, activeState: 'waiting' },
    executing: { activeIndex: 1, activeState: 'working' },
    'diff-ready': { activeIndex: 2, activeState: 'waiting' },
    testing: { activeIndex: 3, activeState: 'working' },
    reviewing: { activeIndex: 4, activeState: 'working' },
    done: { activeIndex: 5, activeState: 'waiting' },
    kept: { activeIndex: 5, activeState: 'completed' },
  };

  const mapped = byStatus[run.status];
  if (mapped) {
    return mapped;
  }

  const stoppedIndex = inferStoppedStepIndex(run);
  return {
    activeIndex: stoppedIndex,
    activeState: run.status === 'failed' ? 'failed' : 'discarded',
  };
}

/** Used by PairPanel (same module) to render the six-stage Pair workflow indicator. */
export default function PairStepIndicator({ run }: PairStepIndicatorProps) {
  const { activeIndex, activeState } = resolveStepProgress(run);

  return (
    <ol aria-label="Pair workflow steps" className="flex flex-wrap items-center gap-2">
      {PAIR_STEPS.map((label, index) => {
        const isBefore = activeIndex > index || activeState === 'completed';
        const isCurrent = activeIndex === index && activeState !== 'completed';

        const pillClass = isBefore
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : isCurrent && activeState === 'failed'
            ? 'border-destructive/50 bg-destructive/10 text-destructive'
            : isCurrent && activeState === 'discarded'
              ? 'border-border bg-muted/40 text-muted-foreground line-through'
              : isCurrent
                ? 'border-primary/60 bg-primary/10 font-medium text-foreground'
                : 'border-border/60 bg-muted/20 text-muted-foreground';

        return (
          <li
            key={label}
            aria-current={isCurrent ? 'step' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
              pillClass,
            )}
          >
            {isBefore ? (
              <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
            ) : isCurrent && activeState === 'working' ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
            ) : isCurrent && activeState === 'failed' ? (
              <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
            ) : (
              <span className="text-[11px] opacity-70" aria-hidden="true">
                {index + 1}.
              </span>
            )}
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
