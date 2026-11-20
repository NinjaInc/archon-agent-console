import { MessageSquare, MessageSquareText, Sparkles, Terminal, Folder, GitBranch, MonitorPlay, Server, type LucideIcon } from 'lucide-react';
import { Fragment } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip, PillBar, Pill } from '@/shared/ui';
import type { AppTab } from '@/shared/types';

type WorkspaceTabsProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowBrowserTab: boolean;
  /** True once the Prod Claude terminal (ssh to the production host) is set up on the server. */
  shouldShowProdTab: boolean;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};


const BASE_TABS: BuiltInTab[] = [
  // The two chats first (Claude, then Antigravity), then the two code terminals, then the project views.
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { kind: 'builtin', id: 'agy-chat', labelKey: 'tabs.agyChat', icon: MessageSquareText },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'agy',   labelKey: 'tabs.agy',   icon: Sparkles },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
];

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
}: WorkspaceTabsProps) {
  const { t } = useTranslation();

  // Plugin tabs and Tasks live in the sidebar footer (SidebarFooter), not in this bar.
  // Prod Claude sits right after the two local terminals, so the three terminals stay together.
  const withProd = shouldShowProdTab
    ? [...BASE_TABS.slice(0, 4), PROD_TAB, ...BASE_TABS.slice(4)]
    : BASE_TABS;
  const tabs: BuiltInTab[] = [...withProd, ...(shouldShowBrowserTab ? [BROWSER_TAB] : [])];

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
        const displayLabel = t(tab.labelKey);

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
                  <tab.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
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
