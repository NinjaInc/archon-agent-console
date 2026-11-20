import { ShieldAlert } from 'lucide-react';

import type { Project } from '@/shared/types';
import { StandaloneShell } from '@/modules/standalone-shell';
import { useProdClaudeStatus } from '@/modules/prod-claude/hooks/useProdClaudeStatus';

type ProdClaudePanelProps = {
  /** Only used to give the terminal a stable identity; Prod Claude runs on the production host, not in a local folder. */
  project: Project;
  isActive: boolean;
};

/** Rendered by ProjectWorkspace's WorkspaceMain for the Prod Claude tab: a terminal into the Claude Code running on the production host, kept visibly separate from this server's agents. */
export default function ProdClaudePanel({ project, isActive }: ProdClaudePanelProps) {
  const status = useProdClaudeStatus();

  return (
    <div className="flex h-full flex-col">
      <div role="note" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-red-500/40 bg-red-500/10 px-4 py-2 text-xs text-red-200">
        <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" />
        <strong className="tracking-wide text-red-300">PRODUCTION</strong>
        <span>
          This is the Claude Code running on {status.host ? <code className="rounded bg-red-500/20 px-1">{status.user}@{status.host}</code> : 'the production server'}.
          It is a separate session: it has no access to this server's files, Google Drive or agents, and they have none to it.
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <StandaloneShell project={project} session={null} agentOverride="prod-claude" showHeader={false} isActive={isActive} />
      </div>
    </div>
  );
}
