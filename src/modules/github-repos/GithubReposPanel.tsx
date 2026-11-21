import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, FolderGit2, Loader2, Lock, RefreshCw, Search } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Badge, Button } from '@/shared/ui';
import type { Project } from '@/shared/types';

type GithubRepo = {
  nameWithOwner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  isFork: boolean;
  language: string | null;
  pushedAt: string | null;
  url: string;
  localPath: string;
  cloned: boolean;
};

type OpenResult = { project: Partial<Project> & { alreadyRegistered?: boolean } };

type Filter = 'all' | 'cloned' | 'missing';

type GithubReposPanelProps = {
  /** Switches the app to the project that was just opened or cloned. */
  onProjectSelect: (project: Project) => void;
  /** Re-syncs the sidebar project list after a repo is registered. */
  onProjectsRefresh: () => void;
};

function formatAge(iso: string | null): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 31) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Rendered by ProjectWorkspace's WorkspaceMain when the sidebar "GitHub" tool is chosen; lists the GitHub account's repositories and opens or clones them as projects. */
export default function GithubReposPanel({ onProjectSelect, onProjectsRefresh }: GithubReposPanelProps) {
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async (refresh: boolean) => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await readApiJson<{ repos: GithubRepo[] }>(await api.githubRepos.list(refresh));
      setRepos(data.repos);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load GitHub repositories');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const act = useCallback(async (repo: GithubRepo) => {
    setBusy(repo.nameWithOwner);
    setError(null);
    setNotice(null);
    try {
      const response = repo.cloned ? await api.githubRepos.open(repo.nameWithOwner) : await api.githubRepos.clone(repo.nameWithOwner);
      const { project } = await readApiJson<OpenResult>(response);
      onProjectsRefresh();
      if (project.projectId) {
        onProjectSelect(project as Project);
      } else {
        setNotice(`${repo.name} is already in your projects.`);
      }
      if (!repo.cloned) {
        void load(true);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  }, [load, onProjectSelect, onProjectsRefresh]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return repos.filter((repo) => {
      if (filter === 'cloned' && !repo.cloned) return false;
      if (filter === 'missing' && repo.cloned) return false;
      return !needle || repo.nameWithOwner.toLowerCase().includes(needle) || repo.description.toLowerCase().includes(needle);
    });
  }, [repos, search, filter]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-3">
        <FolderGit2 className="h-5 w-5 text-primary" />
        <div className="mr-auto">
          <h2 className="text-base font-semibold text-foreground">GitHub repositories</h2>
          <p className="text-xs text-muted-foreground">
            {repos.length} repos, {repos.filter((repo) => repo.cloned).length} on this server
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search repositories"
            aria-label="Search repositories"
            className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-sm outline-none focus:border-primary"
          />
        </div>
        <div className="flex gap-1" role="group" aria-label="Filter repositories">
          {(['all', 'cloned', 'missing'] as const).map((value) => (
            <Button key={value} size="sm" variant={filter === value ? 'default' : 'outline'} onClick={() => setFilter(value)}>
              {value === 'all' ? 'All' : value === 'cloned' ? 'On server' : 'Not cloned'}
            </Button>
          ))}
        </div>
        <Button size="sm" variant="outline" onClick={() => void load(true)} disabled={isLoading} aria-label="Refresh from GitHub">
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {(error || notice) && (
        <div role="status" className={`mx-4 mt-3 rounded-lg border px-3 py-2 text-sm ${error ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-primary/30 bg-primary/10 text-foreground'}`}>
          {error ?? notice}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {isLoading && repos.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading from GitHub…</div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repositories match.</p>
        ) : (
          <ul className="grid gap-2 lg:grid-cols-2">
            {visible.map((repo) => (
              <li key={repo.nameWithOwner} className="flex items-start gap-3 rounded-xl border border-border/60 bg-card/60 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{repo.name}</span>
                    {repo.isPrivate && <Badge variant="secondary"><Lock className="mr-1 h-3 w-3" />Private</Badge>}
                    {repo.isFork && <Badge variant="outline">Fork</Badge>}
                    {repo.cloned && <Badge variant="outline">On server</Badge>}
                  </div>
                  {repo.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{repo.description}</p>}
                  <p className="mt-1 text-[11px] text-muted-foreground/70">
                    {[repo.language, repo.pushedAt ? `pushed ${formatAge(repo.pushedAt)}` : null].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <Button size="sm" onClick={() => void act(repo)} disabled={busy !== null}>
                    {busy === repo.nameWithOwner ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : repo.cloned ? 'Open' : 'Clone & open'}
                  </Button>
                  <a href={repo.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
                    GitHub <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
