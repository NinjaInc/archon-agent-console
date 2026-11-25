import { Loader2, Plus, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import PairDiffBlock from '@/modules/pair/PairDiffBlock';
import PairStepIndicator from '@/modules/pair/PairStepIndicator';
import { PlanUsageChips } from '@/modules/plan-usage';
import { api, readApiJson } from '@/shared/api';
import type { PairRun, PairRunSummary, PairStatus, PairVerdict, Project } from '@/shared/types';
import { Badge, Button } from '@/shared/ui';

const POLL_INTERVAL_MS = 3000;

const WORKING_STATUSES: ReadonlySet<PairStatus> = new Set([
  'planning',
  'executing',
  'testing',
  'reviewing',
]);

const WORKING_LABELS: Record<'planning' | 'executing' | 'testing' | 'reviewing', string> = {
  planning: 'Claude is planning the change…',
  executing: 'Antigravity is editing files in an isolated worktree…',
  testing: 'Running tests on the approved change…',
  reviewing: 'Claude is reviewing the diff and test output…',
};

const VERDICT_META: Record<PairVerdict, { label: string; className: string }> = {
  ready: {
    label: 'ready',
    className: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  },
  'needs-work': {
    label: 'needs work',
    className: 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300',
  },
  unclear: {
    label: 'unclear',
    className: 'border-border bg-muted text-muted-foreground',
  },
};

function pickDefaultPairModel(availableModels: string[]): string {
  return availableModels.find((entry) => entry.includes('carbon-medium')) ?? availableModels[0] ?? '';
}

function toRunSummary(run: PairRun): PairRunSummary {
  return {
    id: run.id,
    title: run.task.split('\n')[0].slice(0, 80),
    status: run.status,
    createdAt: run.createdAt,
    ...(run.verdict ? { verdict: run.verdict } : {}),
  };
}

type PairPanelProps = {
  /** Active workspace project whose Pair runs are listed and started. */
  selectedProject: Project;
};

/** Used by the project-workspace module (WorkspaceMain) to render the Pair mode tab. */
export default function PairPanel({ selectedProject }: PairPanelProps) {
  return <PairPanelProjectView key={selectedProject.projectId} selectedProject={selectedProject} />;
}

function PairPanelProjectView({ selectedProject }: PairPanelProps) {
  const projectId = selectedProject.projectId;

  // Recent Pair runs for this project, powering the header's run picker.
  const [runs, setRuns] = useState<PairRunSummary[]>([]);
  // Currently inspected Pair run, or null when composing a new task.
  const [run, setRun] = useState<PairRun | null>(null);
  // Available Antigravity model identifiers loaded from `/api/agy-chat/models`.
  const [models, setModels] = useState<string[]>([]);
  // Chosen Antigravity model for starting the next Pair run.
  const [model, setModel] = useState('');
  // Task description draft entered in the new-task form.
  const [task, setTask] = useState('');
  // True while a user-initiated API request is in flight, disabling action controls.
  const [requestInFlight, setRequestInFlight] = useState(false);
  // Plain-text error message from the last failed API call, cleared before the next user action.
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const viewSeqRef = useRef(0);
  const draftTouchedRef = useRef(false);

  const applyRun = useCallback((nextRun: PairRun) => {
    setRun(nextRun);
    setRuns((previous) => {
      const summary = toRunSummary(nextRun);
      const existingIndex = previous.findIndex((entry) => entry.id === nextRun.id);
      if (existingIndex === -1) {
        return [summary, ...previous];
      }
      return previous.map((entry, index) => (index === existingIndex ? summary : entry));
    });
  }, []);

  const openRun = useCallback(
    async (runId: string) => {
      const seq = ++viewSeqRef.current;
      setRequestInFlight(true);
      setError(null);
      try {
        const data = await readApiJson<{ run: PairRun }>(await api.pair.get(runId));
        if (!mountedRef.current || seq !== viewSeqRef.current) return;
        applyRun(data.run);
      } catch (caught) {
        if (!mountedRef.current || seq !== viewSeqRef.current) return;
        setError(caught instanceof Error ? caught.message : 'Could not load Pair run');
      } finally {
        if (mountedRef.current && seq === viewSeqRef.current) {
          setRequestInFlight(false);
        }
      }
    },
    [applyRun],
  );

  // Load the project's recent Pair runs and Antigravity models when mounted for this project.
  useEffect(() => {
    mountedRef.current = true;
    const seq = ++viewSeqRef.current;

    (async () => {
      try {
        const [listResponse, modelsResponse] = await Promise.all([
          api.pair.list(projectId),
          api.agyChat.models(),
        ]);
        const [listData, modelData] = await Promise.all([
          readApiJson<{ runs: PairRunSummary[] }>(listResponse),
          readApiJson<{ models: string[] }>(modelsResponse),
        ]);
        if (!mountedRef.current || seq !== viewSeqRef.current) return;

        const nextModels = Array.isArray(modelData.models) ? modelData.models : [];
        const nextRuns = Array.isArray(listData.runs) ? listData.runs : [];
        setModels(nextModels);
        setModel((current) => current || pickDefaultPairModel(nextModels));
        setRuns(nextRuns);

        if (nextRuns.length > 0 && !draftTouchedRef.current) {
          const initialResponse = await api.pair.get(nextRuns[0].id);
          if (!initialResponse || !mountedRef.current || seq !== viewSeqRef.current) return;
          const runData = await readApiJson<{ run: PairRun }>(initialResponse);
          if (!mountedRef.current || seq !== viewSeqRef.current) return;
          applyRun(runData.run);
        }
      } catch (caught) {
        if (!mountedRef.current || seq !== viewSeqRef.current) return;
        setError(caught instanceof Error ? caught.message : 'Could not load Pair mode');
      }
    })();

    return () => {
      mountedRef.current = false;
      viewSeqRef.current += 1;
    };
  }, [projectId, applyRun]);

  const isWorking = run !== null && WORKING_STATUSES.has(run.status);
  const activeWorkingRunId = isWorking ? run.id : null;

  // Poll GET /api/pair/:id every 3s while the open run is working and the page is visible.
  useEffect(() => {
    if (!activeWorkingRunId) return undefined;
    let cancelled = false;
    let pollInFlight = false;

    const poll = async () => {
      if (cancelled || pollInFlight || document.visibilityState !== 'visible') {
        return;
      }
      const seqAtStart = viewSeqRef.current;
      pollInFlight = true;
      try {
        const data = await readApiJson<{ run: PairRun }>(await api.pair.get(activeWorkingRunId));
        if (cancelled || !mountedRef.current || seqAtStart !== viewSeqRef.current) {
          return;
        }
        applyRun(data.run);
      } catch {
        // Transient network hiccups retry on the next poll tick.
      } finally {
        pollInFlight = false;
      }
    };

    const timer = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void poll();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeWorkingRunId, applyRun]);

  const showNewTask = () => {
    viewSeqRef.current += 1;
    draftTouchedRef.current = true;
    setRun(null);
    setError(null);
  };

  const runMutation = async (request: () => Promise<Response>) => {
    if (requestInFlight) return;
    const seq = ++viewSeqRef.current;
    setRequestInFlight(true);
    setError(null);
    try {
      const data = await readApiJson<{ run: PairRun }>(await request());
      if (!mountedRef.current || seq !== viewSeqRef.current) return;
      applyRun(data.run);
    } catch (caught) {
      if (!mountedRef.current || seq !== viewSeqRef.current) return;
      setError(caught instanceof Error ? caught.message : 'Request failed');
    } finally {
      if (mountedRef.current && seq === viewSeqRef.current) {
        setRequestInFlight(false);
      }
    }
  };

  const handleStart = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTask = task.trim();
    if (!trimmedTask || !model || requestInFlight) return;

    const seq = ++viewSeqRef.current;
    draftTouchedRef.current = true;
    setRequestInFlight(true);
    setError(null);
    try {
      const data = await readApiJson<{ run: PairRun }>(
        await api.pair.start({ projectId, task: trimmedTask, model }),
      );
      if (!mountedRef.current || seq !== viewSeqRef.current) return;
      setTask('');
      applyRun(data.run);
    } catch (caught) {
      if (!mountedRef.current || seq !== viewSeqRef.current) return;
      setError(caught instanceof Error ? caught.message : 'Could not start Pair run');
    } finally {
      if (mountedRef.current && seq === viewSeqRef.current) {
        setRequestInFlight(false);
      }
    }
  };

  const handleApproveDiff = async () => {
    if (!run?.diff || requestInFlight) return;
    const runId = run.id;
    const diffHash = run.diff.hash;
    const seq = ++viewSeqRef.current;
    setRequestInFlight(true);
    setError(null);
    try {
      const data = await readApiJson<{ run: PairRun }>(await api.pair.approveDiff(runId, diffHash));
      if (!mountedRef.current || seq !== viewSeqRef.current) return;
      applyRun(data.run);
    } catch (caught) {
      if (!mountedRef.current || seq !== viewSeqRef.current) return;
      setError(caught instanceof Error ? caught.message : 'Could not approve diff');
      if ((caught as { code?: unknown })?.code === 'PAIR_DIFF_CHANGED') {
        try {
          const refreshed = await readApiJson<{ run: PairRun }>(await api.pair.get(runId));
          if (!mountedRef.current || seq !== viewSeqRef.current) return;
          applyRun(refreshed.run);
        } catch {
          // Keep the PAIR_DIFF_CHANGED error visible even if reloading fails.
        }
      }
    } finally {
      if (mountedRef.current && seq === viewSeqRef.current) {
        setRequestInFlight(false);
      }
    }
  };

  const verdictMeta = run?.verdict ? VERDICT_META[run.verdict] : VERDICT_META.unclear;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PlanUsageChips refreshKey={run?.status} className="border-b border-border/60 px-3 py-1.5" />

      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <select
          aria-label="Pair run"
          value={run?.id ?? ''}
          onChange={(event) => {
            const selectedId = event.target.value;
            if (selectedId) {
              void openRun(selectedId);
            } else {
              showNewTask();
            }
          }}
          disabled={requestInFlight}
          className="h-9 max-w-xs rounded-lg border border-border bg-background px-2.5 text-sm text-foreground"
        >
          <option value="">New task</option>
          {runs.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.title} ({entry.status})
            </option>
          ))}
        </select>

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={showNewTask}
          disabled={requestInFlight}
        >
          <Plus className="h-3.5 w-3.5" />
          New task
        </Button>

        {isWorking && run && (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => void runMutation(() => api.pair.stop(run.id))}
            disabled={requestInFlight}
            className="ml-auto"
          >
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          <PairStepIndicator run={run} />

          {error && (
            <div
              role="alert"
              className="rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive"
            >
              {error}
            </div>
          )}

          {!run ? (
            <form
              onSubmit={(event) => void handleStart(event)}
              className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-background/60 p-4"
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor="pair-task-textarea" className="text-xs font-medium text-foreground">
                  Task
                </label>
                <textarea
                  id="pair-task-textarea"
                  value={task}
                  onChange={(event) => {
                    draftTouchedRef.current = true;
                    setTask(event.target.value);
                  }}
                  rows={4}
                  maxLength={8000}
                  placeholder="Describe the change for Claude to plan and Antigravity to implement…"
                  className="min-h-28 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="pair-model-select" className="text-xs font-medium text-foreground">
                    Model
                  </label>
                  <select
                    id="pair-model-select"
                    value={model}
                    onChange={(event) => {
                      draftTouchedRef.current = true;
                      setModel(event.target.value);
                    }}
                    disabled={requestInFlight || models.length === 0}
                    className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary"
                  >
                    {models.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                </div>

                <Button
                  type="submit"
                  disabled={requestInFlight || !task.trim() || !model}
                  className="ml-auto"
                >
                  Start
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="rounded-2xl border border-border/60 bg-background/60 p-4">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>Task</span>
                  <span className="font-mono">{run.model}</span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm text-foreground">{run.task}</p>
              </div>

              {isWorking && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-muted/30 px-3.5 py-3 text-sm text-foreground"
                >
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
                  <span>
                    {WORKING_LABELS[run.status as 'planning' | 'executing' | 'testing' | 'reviewing']}
                  </span>
                </div>
              )}

              {run.status === 'plan-ready' && (
                <section aria-label="Proposed plan" className="flex flex-col gap-3">
                  <h3 className="text-sm font-semibold text-foreground">Plan</h3>
                  <pre className="whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-muted/20 p-3.5 font-sans text-sm text-foreground">
                    {run.plan ?? ''}
                  </pre>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      onClick={() => void runMutation(() => api.pair.approvePlan(run.id))}
                      disabled={requestInFlight}
                    >
                      Approve plan
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void runMutation(() => api.pair.discard(run.id))}
                      disabled={requestInFlight}
                    >
                      Discard
                    </Button>
                  </div>
                </section>
              )}

              {run.status === 'diff-ready' && (
                <section aria-label="Proposed change" className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-foreground">Review change</h3>
                    <span className="rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-foreground">
                      {run.round > 0 ? `Round ${run.round + 1} (fix ${run.round})` : 'Round 1'}
                    </span>
                  </div>

                  {run.diff && <PairDiffBlock diff={run.diff} />}

                  <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-muted-foreground">Test command:</span>
                      <code className="rounded bg-background/80 px-2 py-0.5 font-mono text-xs text-foreground">
                        {run.testCommand && run.testCommand.length > 0
                          ? run.testCommand.join(' ')
                          : 'No tests found'}
                      </code>
                    </div>
                    <p className="mt-1.5 text-xs font-medium text-amber-800 dark:text-amber-200">
                      Approving runs this code on the server as your user
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      onClick={() => void handleApproveDiff()}
                      disabled={requestInFlight || !run.diff}
                    >
                      Approve and run tests
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void runMutation(() => api.pair.discard(run.id))}
                      disabled={requestInFlight}
                    >
                      Discard
                    </Button>
                  </div>
                </section>
              )}

              {run.status === 'done' && (
                <section aria-label="Review outcome" className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">Review</h3>
                    <Badge variant="outline" className={verdictMeta.className}>
                      {verdictMeta.label}
                    </Badge>
                  </div>

                  {run.review && (
                    <pre className="whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-muted/20 p-3.5 font-sans text-sm text-foreground">
                      {run.review}
                    </pre>
                  )}

                  {run.tests ? (
                    <details className="rounded-xl border border-border/60 bg-muted/20 px-3.5 py-2.5 text-sm">
                      <summary className="flex cursor-pointer items-center gap-2 font-medium text-foreground">
                        <span
                          className={
                            run.tests.passed
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-red-600 dark:text-red-400'
                          }
                        >
                          {run.tests.passed ? 'Tests passed' : 'Tests failed'}
                        </span>
                        <span className="text-xs font-normal text-muted-foreground">Test output</span>
                      </summary>
                      <pre className="mt-2.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/50 bg-background p-2.5 font-mono text-xs text-foreground">
                        {run.tests.output || '(no output)'}
                      </pre>
                    </details>
                  ) : (
                    <p className="text-xs text-muted-foreground">No tests found</p>
                  )}

                  {run.diff && <PairDiffBlock diff={run.diff} />}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      onClick={() => void runMutation(() => api.pair.keep(run.id))}
                      disabled={requestInFlight}
                    >
                      Keep on branch
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void runMutation(() => api.pair.discard(run.id))}
                      disabled={requestInFlight}
                    >
                      Discard
                    </Button>
                  </div>
                </section>
              )}

              {run.status === 'kept' && (
                <div
                  role="status"
                  className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-foreground"
                >
                  <p className="font-medium">
                    Saved on branch{' '}
                    <code className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-xs">
                      {run.branch}
                    </code>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">Nothing was merged or pushed</p>
                </div>
              )}

              {run.status === 'failed' && (
                <section aria-label="Failed run details" className="flex flex-col gap-3">
                  <div
                    role="alert"
                    className="rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive"
                  >
                    {run.error || 'Run failed'}
                  </div>

                  {run.agentNotes && (
                    <div className="flex flex-col gap-1.5">
                      <h3 className="text-xs font-medium text-muted-foreground">Agent notes</h3>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-muted/20 p-3 font-mono text-xs text-foreground">
                        {run.agentNotes}
                      </pre>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void runMutation(() => api.pair.discard(run.id))}
                      disabled={requestInFlight}
                    >
                      Discard
                    </Button>
                  </div>
                </section>
              )}

              {run.status === 'discarded' && (
                <div
                  role="status"
                  className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground"
                >
                  This run was discarded.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
