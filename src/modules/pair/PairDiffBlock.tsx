import { AlertTriangle } from 'lucide-react';

import type { PairDiffSnapshot } from '@/shared/types';
import { cn } from '@/shared/utils';

type DiffLineKind = 'header' | 'hunk' | 'added' | 'removed' | 'context';

type PairDiffBlockProps = {
  /** Worktree diff snapshot to display, including changed file paths and symlink flag. */
  diff: PairDiffSnapshot;
};

function classifyDiffLine(line: string): { kind: DiffLineKind; className: string } {
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++')
  ) {
    return { kind: 'header', className: 'font-semibold text-muted-foreground' };
  }
  if (line.startsWith('@@')) {
    return { kind: 'hunk', className: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' };
  }
  if (line.startsWith('+')) {
    return { kind: 'added', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' };
  }
  if (line.startsWith('-')) {
    return { kind: 'removed', className: 'bg-red-500/15 text-red-700 dark:text-red-300' };
  }
  return { kind: 'context', className: 'text-foreground' };
}

function splitDiffLines(text: string): string[] {
  if (!text) return [];
  const raw = text.split('\n');
  return raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
}

/** Used by PairPanel (same module) to render changed files, a symlink warning and the line-coloured unified diff. */
export default function PairDiffBlock({ diff }: PairDiffBlockProps) {
  const lines = splitDiffLines(diff.text);

  return (
    <div className="flex flex-col gap-3">
      {diff.hasSymlinks && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-amber-500/50 bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <div>
            <p className="font-semibold">Warning: Symbolic links detected in this diff</p>
            <p className="text-xs">
              This change adds or modifies one or more symlinks. Check every symlink target carefully before approving, as symlinks can point outside the repository.
            </p>
          </div>
        </div>
      )}

      {diff.files.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-background/60 px-3.5 py-2.5">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            Files changed ({diff.files.length})
          </p>
          <ul aria-label="Changed files" className="flex flex-wrap gap-1.5">
            {diff.files.map((file) => (
              <li
                key={file}
                className="rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 font-mono text-xs text-foreground"
              >
                {file}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        aria-label="Unified diff"
        className="max-h-96 overflow-auto rounded-xl border border-border bg-muted/20 p-3 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="text-muted-foreground">(empty diff)</p>
        ) : (
          lines.map((line, index) => {
            const { kind, className } = classifyDiffLine(line);
            return (
              <div
                key={index}
                data-diff-line={kind}
                className={cn('min-h-4 whitespace-pre rounded-sm px-1.5', className)}
              >
                {line}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
