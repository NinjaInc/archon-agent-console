import { ClipboardCheck, LayoutGrid, Puzzle } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { ActionMenu } from '@/shared/ui';
import type { ActionMenuItem } from '@/shared/ui/ActionMenu';
import type { AppTab } from '@/shared/types';
import { usePlugins } from '@/modules/plugins';

type WorkspaceMoreMenuProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
};

/** Rendered by WorkspaceHeader beside the tab bar: Tasks and every enabled plugin (Claude Usage, Sessions, Scheduled Prompt…) in one dropdown, so the tab bar stays short. */
export default function WorkspaceMoreMenu({ activeTab, setActiveTab, shouldShowTasksTab }: WorkspaceMoreMenuProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const items: ActionMenuItem[] = [
    ...(shouldShowTasksTab
      ? [{ key: 'tasks', label: t('tabs.tasks'), icon: ClipboardCheck, onSelect: () => setActiveTab('tasks') }]
      : []),
    ...plugins
      .filter((plugin) => plugin.enabled)
      .map((plugin): ActionMenuItem => ({
        key: `plugin:${plugin.name}`,
        label: plugin.displayName,
        icon: Puzzle,
        onSelect: () => setActiveTab(`plugin:${plugin.name}` as AppTab),
      })),
  ];

  if (items.length === 0) return null;

  // When one of these is the open view, the trigger names it so the user can see where they are.
  const activeItem = items.find((item) => item.key === activeTab);

  return (
    <ActionMenu
      label={activeItem ? activeItem.label : t('tabs.more', { defaultValue: 'More' })}
      ariaLabel={t('tabs.moreTools', { defaultValue: 'More tools' })}
      icon={LayoutGrid}
      items={items}
      portal
      align="right"
      variant={activeItem ? 'default' : 'outline'}
      size="sm"
      iconOnly={!activeItem}
      triggerClassName="h-8 rounded-full px-3"
    />
  );
}
