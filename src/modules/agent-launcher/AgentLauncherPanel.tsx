import { useMemo, useState } from 'react';
import { GitFork, Loader2, Rocket } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import type { AppTab, Project } from '@/shared/types';

type LaunchAgent = {
  id: string;
  label: string;
  /** Used in the branch name: agent/<branchKey>/<task>. */
  branchKey: string;
  /** The workspace tab the new worktree opens in. */
  tab: AppTab;
};

const AGENTS: LaunchAgent[] = [
  { id: 'claude-chat', label: 'Claude · chat', branchKey: 'claude', tab: 'chat' },
  { id: 'agy-chat', label: 'Antigravity · chat', branchKey: 'agy', tab: 'agy-chat' },
  { id: 'claude-terminal', label: 'Claude · terminal', branchKey: 'claude', tab: 'shell' },
  { id: 'agy-terminal', label: 'Antigravity · terminal', branchKey: 'agy', tab: 'agy' },
];

type LauncherProps = {
  projects: Project[];
  selectedProject: Project | null;
  /** Switches the app to the worktree project that was just created. */
  onProjectSelect: (project: Project) => void;
  /** Re-syncs the sidebar project list. */
  onProjectsRefresh: () => void;
  /** Opens the tab for the chosen agent once the worktree project is selected. */
  onOpenTab: (tab: AppTab) => void;
};

type CreateEnvelope = { data?: { project?: Project; worktreePath?: string } };

function slugify(task: string): string {
  return task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Rendered by ProjectWorkspace's WorkspaceMain for the sidebar "Launch agent" tool; creates a git worktree for a task and opens it with the chosen agent. */
export default function AgentLauncherPanel({ projects, selectedProject, onProjectSelect, onProjectsRefresh, onOpenTab }: LauncherProps) {
  const [projectId, setProjectId] = useState(selectedProject?.projectId ?? '');
  const [agentId, setAgentId] = useState(AGENTS[0].id);
  const [task, setTask] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agent = AGENTS.find((entry) => entry.id === agentId) ?? AGENTS[0];
  const slug = slugify(task) || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const branch = `agent/${agent.branchKey}/${slug}`;
  const chosenProject = useMemo(() => projects.find((project) => project.projectId === projectId) ?? null, [projects, projectId]);

  const launch = async () => {
    if (!chosenProject) return;
    setIsLaunching(true);
    setError(null);
    try {
      const response = await api.worktrees.create(chosenProject.projectId, { branch, baseBranch: baseBranch.trim() || null });
      const envelope = await readApiJson<CreateEnvelope>(response);
      const worktreeProject = envelope.data?.project;
      if (!worktreeProject) {
        throw new Error('The worktree was created but could not be opened as a project');
      }
      onProjectsRefresh();
      onProjectSelect(worktreeProject);
      onOpenTab(agent.tab);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not launch the agent');
    } finally {
      setIsLaunching(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-xl flex-col gap-5 px-4 py-6">
        <div className="flex items-center gap-3">
          <Rocket className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-base font-semibold text-foreground">Launch an agent in a worktree</h2>
            <p className="text-xs text-muted-foreground">
              Each task gets its own git worktree and branch, so agents never edit the same files at once.
            </p>
          </div>
        </div>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Repository</span>
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
          >
            <option value="">Choose a project…</option>
            {projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.displayName} — {project.fullPath}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="flex flex-col gap-1.5 text-sm">
          <legend className="mb-1.5 font-medium text-foreground">Agent</legend>
          <div className="flex flex-wrap gap-2">
            {AGENTS.map((entry) => (
              <Button key={entry.id} type="button" size="sm" variant={entry.id === agentId ? 'default' : 'outline'} onClick={() => setAgentId(entry.id)}>
                {entry.label}
              </Button>
            ))}
          </div>
        </fieldset>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Task</span>
          <input
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="e.g. fix login redirect"
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
          />
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <GitFork className="h-3 w-3" /> branch <code className="rounded bg-muted px-1.5 py-0.5">{branch}</code>
          </span>
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Start from <span className="font-normal text-muted-foreground">(optional)</span></span>
          <input
            value={baseBranch}
            onChange={(event) => setBaseBranch(event.target.value)}
            placeholder="the repository's current branch"
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
          />
        </label>

        {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

        <Button type="button" onClick={() => void launch()} disabled={!chosenProject || isLaunching} className="self-start">
          {isLaunching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rocket className="mr-2 h-4 w-4" />}
          Create worktree and open
        </Button>
      </div>
    </div>
  );
}
