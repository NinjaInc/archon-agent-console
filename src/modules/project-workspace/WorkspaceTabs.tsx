import { Cpu, Folder, GitBranch, GitPullRequest, Image as ImageIcon, MessageSquare, MessageSquareText, MonitorPlay, Server, Sparkles, Terminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Fragment } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { AppTab } from '@/shared/types';
import { Pill, PillBar, Tooltip } from '@/shared/ui';

type WorkspaceTabsProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowBrowserTab: boolean;
  /** True once the Prod Claude terminal (ssh to the production host) is set up on the server. */
  shouldShowProdTab: boolean;
  /** True once the Local (Ollama) model is set up on the server. */
  shouldShowLocalTab?: boolean;
  /** Colours the dot on the Local tab: green when the host answers, red when it does not. */
  localStatus?: 'unknown' | 'online' | 'offline';
  /** True once ComfyUI image generation is set up on the server. */
  shouldShowImagesTab?: boolean;
  /** Colours the dot on the Images tab: green when ComfyUI answers, red when it does not. */
  imagesOnline?: boolean;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  defaultLabel?: string;
  icon: LucideIcon;
};


const BASE_TABS: BuiltInTab[] = [
  // The two chats first (Claude, then Antigravity), Pair, then the two code terminals, then the project views.
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { kind: 'builtin', id: 'agy-chat', labelKey: 'tabs.agyChat', icon: MessageSquareText },
  { kind: 'builtin', id: 'pair', labelKey: 'tabs.pair', defaultLabel: 'Pair', icon: GitPullRequest },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'agy',   labelKey: 'tabs.agy',   icon: Sparkles },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
];

const LOCAL_TAB: BuiltInTab = { kind: 'builtin', id: 'local', labelKey: 'tabs.local', defaultLabel: 'Local LLM', icon: Cpu };

const IMAGES_TAB: BuiltInTab = { kind: 'builtin', id: 'images', labelKey: 'tabs.images', defaultLabel: 'Images', icon: ImageIcon };

const PROD_TAB: BuiltInTab = { kind: 'builtin', id: 'prod', labelKey: 'tabs.prod', icon: Server };

const BROWSER_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'browser',
  labelKey: 'tabs.browser',
  icon: MonitorPlay,
};

/** Rendered by WorkspaceHeader to show the core workspace tabs; plugin tabs and Tasks are reached from the sidebar footer. */
export default function WorkspaceTabs({
  activeTab,
  setActiveTab,
  shouldShowBrowserTab,
  shouldShowProdTab,
  shouldShowLocalTab = false,
  localStatus = 'unknown',
  shouldShowImagesTab = false,
  imagesOnline,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();

  // Plugin tabs and Tasks live in the sidebar footer (SidebarFooter), not in this bar.
  // Prod Claude sits right after the two local terminals, so the three terminals stay together.
  // Order: the chats (Claude, Agy), Pair, then the Local model and Images, the code terminals (+ Prod Claude), then the project views.
  const [claudeChat, agyChat, pairTab, claudeShell, agyShell, ...projectViews] = BASE_TABS;
  const tabs: BuiltInTab[] = [
    claudeChat,
    agyChat,
    pairTab,
    ...(shouldShowLocalTab ? [LOCAL_TAB] : []),
    ...(shouldShowImagesTab ? [IMAGES_TAB] : []),
    claudeShell,
    agyShell,
    ...(shouldShowProdTab ? [PROD_TAB] : []),
    ...projectViews,
    ...(shouldShowBrowserTab ? [BROWSER_TAB] : []),
  ];

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabList = event.currentTarget.closest('[role="tablist"]');
    if (!tabList) return;

    const tabButtons = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabButtons.indexOf(event.currentTarget);
    let nextIndex: number;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabButtons.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabButtons.length - 1;
    else return;

    event.preventDefault();
    tabButtons[nextIndex]?.focus();
    tabButtons[nextIndex]?.click();
  };

  return (
    <PillBar
      role="tablist"
      aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
      className="min-w-max border border-border/40 bg-muted/50 shadow-inner shadow-black/[0.025] dark:shadow-black/10"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTab;
        const displayLabel = tab.defaultLabel ? t(tab.labelKey, { defaultValue: tab.defaultLabel }) : t(tab.labelKey);

        return (
          <Fragment key={`${tab.id}-${index}`}>
            <Tooltip content={displayLabel} position="bottom">
              <Pill
                role="tab"
                aria-label={displayLabel}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                isActive={isActive}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={handleTabKeyDown}
                // Production is always red, so it cannot be mistaken for the local Claude tab.
                className={`h-8 max-w-44 px-2.5 py-[5px] ${tab.id === 'prod' ? 'text-red-400 hover:text-red-300' : ''}`}
              >
                <span className="relative inline-flex">
                  <tab.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
                  {tab.id === 'local' && (
                    <span
                      role="img"
                      aria-label={localStatus === 'online' ? 'Local LLM online' : localStatus === 'offline' ? 'Local LLM offline' : 'Local LLM status unknown'}
                      className={`absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full ${localStatus === 'online' ? 'bg-emerald-500' : localStatus === 'offline' ? 'bg-red-500' : 'bg-muted-foreground/50'}`}
                    />
                  )}
                  {tab.id === 'images' && imagesOnline !== undefined && (
                    <span
                      role="img"
                      aria-label={imagesOnline ? 'Images online' : 'Images offline'}
                      className={`absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full ${imagesOnline ? 'bg-emerald-500' : 'bg-red-500'}`}
                    />
                  )}
                </span>
                <span className={`${isActive ? 'inline max-w-28' : 'hidden'} truncate sm:max-w-36 lg:inline`}>
                  {displayLabel}
                </span>
              </Pill>
            </Tooltip>
          </Fragment>
        );
      })}
    </PillBar>
  );
}
