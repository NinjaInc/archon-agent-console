import { Bell, BookOpen, Cpu, ExternalLink, GitBranch, KeyRound, MessageSquare, MessageSquareText, Star, Terminal, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { BRAND_WORDMARK_FONT_FAMILY } from '@/shared/constants';
import { useVersionCheck } from '@/shared/hooks/useVersionCheck';

const FORK_REPO_URL = 'https://github.com/NinjaInc/archon-agent-console';
const UPSTREAM_REPO_URL = 'https://github.com/siteboon/claudecodeui';
const ARCHON_TECH_URL = 'https://archontech.au';

type Feature = { icon: LucideIcon; title: string; text: string };

// What the console does, in plain words. Kept in step with the README; English defaults so every language shows something sensible.
const FEATURES: Feature[] = [
  { icon: KeyRound, title: 'Passkey sign-in', text: 'No passwords. One owner, one passkey, optional Cloudflare Access in front.' },
  { icon: MessageSquare, title: 'Claude Chat', text: 'Claude Code chat with history, tool approvals and file references. The default view.' },
  { icon: MessageSquareText, title: 'Agy Chat', text: 'Structured Antigravity chat with permission modes, live progress and saved history.' },
  { icon: Cpu, title: 'Local LLM', text: 'A small model on your own hardware via Ollama. Draft only: no tools, nothing written or run.' },
  { icon: Terminal, title: 'Terminals', text: 'Claude Code and agy terminals in the project folder, plus an isolated Prod Claude tab.' },
  { icon: GitBranch, title: 'Repos and worktrees', text: 'Clone from GitHub, then launch an agent in its own worktree.' },
  { icon: BookOpen, title: 'Skills', text: 'Import SKILL.md files, folders or zips for Claude Code and Antigravity.' },
  { icon: Bell, title: 'Phone alerts', text: 'Push notifications to Android Chrome when a long reply or a run finishes.' },
];

const SCREENSHOTS = [
  { src: '/about/agy-chat.webp', alt: 'Agy Chat with tool steps and a streamed reply' },
  { src: '/about/local-llm.webp', alt: 'The Local LLM tab drafting a commit message' },
  { src: '/about/github.webp', alt: 'GitHub repositories view' },
];

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

/** Rendered by Settings for the "about" tab, showing the Archon branding, version, links and licence credit. */
export default function AboutTab() {
  const { t } = useTranslation('settings');
  const { currentVersion } = useVersionCheck('NinjaInc', 'archon-agent-console');

  return (
    <div className="space-y-6">
      <img src="/brand/banner.webp" alt="Archon Agent Console by Archon Tech" className="w-full max-w-md rounded-xl border border-border/50" />

      {/* Logo + name + version */}
      <div className="flex items-center gap-3">
        <img src="/logo-128.png" alt="Archon Tech" className="h-10 w-10 flex-shrink-0" />
        <div>
          <div className="flex items-center gap-2">
            <span
              className="text-base font-semibold text-foreground"
              style={{ fontFamily: BRAND_WORDMARK_FONT_FAMILY }}
            >
              Archon Agent Console
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              v{currentVersion}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('about.tagline')}</p>
        </div>
      </div>

      <a
        href={FORK_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <GitHubIcon className="h-4 w-4" />
        <Star className="h-3.5 w-3.5" />
        <span>{t('about.starOnGitHub')}</span>
      </a>

      {/* What it does */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">{t('about.whatItDoes', { defaultValue: 'What is inside' })}</h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="flex gap-2.5 rounded-lg border border-border/50 bg-muted/20 p-2.5">
              <feature.icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-foreground">{feature.title}</p>
                <p className="text-xs text-muted-foreground">{feature.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Screenshots */}
      <div className="grid gap-2 sm:grid-cols-3">
        {SCREENSHOTS.map((shot) => (
          <a key={shot.src} href={shot.src} target="_blank" rel="noopener noreferrer" className="overflow-hidden rounded-lg border border-border/50 transition-opacity hover:opacity-90">
            <img src={shot.src} alt={shot.alt} loading="lazy" className="h-full w-full object-cover" />
          </a>
        ))}
      </div>

      {/* Links */}
      <div className="flex flex-wrap gap-4 text-sm">
        <a
          href={ARCHON_TECH_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          archontech.au
        </a>
        <a
          href={UPSTREAM_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <GitHubIcon className="h-4 w-4" />
          CloudCLI UI (upstream)
        </a>
      </div>

      {/* License */}
      <div className="border-t border-border/50 pt-4">
        <p className="text-xs text-muted-foreground/60">{t('about.licensed')}</p>
      </div>
    </div>
  );
}
