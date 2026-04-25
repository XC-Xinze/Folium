import { CalendarDays, FolderTree, Network, PanelLeftClose, PanelLeftOpen, Search, Settings, Sparkles } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { dialog } from '../lib/dialog';
import { useNavigateToCard } from '../lib/useNavigateToCard';
import { useUIStore } from '../store/uiStore';
import { usePaneStore } from '../store/paneStore';

/**
 * Obsidian-style leftmost vertical ribbon: icon-only navigation strip.
 *   - Collapse button (top)
 *   - Vault: sidebar shows Indexes/Tags/Cards
 *   - Workspaces: sidebar shows workspace list
 *   - Settings (bottom)
 */
export function RibbonBar() {
  const tab = useUIStore((s) => s.sidebarTab);
  const collapsed = useUIStore((s) => s.leftSidebarCollapsed);
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const setQuickSwitcherOpen = useUIStore((s) => s.setQuickSwitcherOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const openTab = usePaneStore((s) => s.openTab);
  // 当前 active tab 是 graph / settings → 高亮对应按钮
  const root = usePaneStore((s) => s.root);
  const activeLeafId = usePaneStore((s) => s.activeLeafId);
  const activeTabKind = (() => {
    function find(node: typeof root): typeof root | null {
      if (node.kind === 'leaf') return node.id === activeLeafId ? node : null;
      for (const c of node.children) {
        const r = find(c);
        if (r) return r;
      }
      return null;
    }
    const leaf = find(root);
    if (leaf?.kind !== 'leaf') return null;
    const t = leaf.tabs.find((x) => x.id === leaf.activeTabId);
    return t?.kind ?? null;
  })();
  const navigate = useNavigateToCard();
  const qc = useQueryClient();
  const openToday = async () => {
    try {
      const { luhmannId, created } = await api.openOrCreateDaily();
      if (created) {
        qc.invalidateQueries({ queryKey: ['cards'] });
        qc.invalidateQueries({ queryKey: ['indexes'] });
        qc.invalidateQueries({ queryKey: ['tags'] });
      }
      navigate(luhmannId);
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Daily note failed' });
    }
  };

  const onTabClick = (t: 'vault' | 'workspaces') => {
    if (collapsed) {
      // Collapsed: clicking a tab expands and switches to it
      setSidebarTab(t);
    } else if (tab === t) {
      // Already on this tab → collapse
      toggleLeftSidebar();
    } else {
      setSidebarTab(t);
    }
  };

  return (
    <div className="w-12 bg-[#f3f3f1] dark:bg-[#181926] border-r border-gray-200 dark:border-[#363a4f] flex flex-col items-center py-2 gap-1 shrink-0">
      <IconButton
        icon={collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        onClick={toggleLeftSidebar}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      />

      <div className="w-6 border-t border-gray-300 my-1" />

      <IconButton
        icon={<Search size={16} />}
        onClick={() => setQuickSwitcherOpen(true)}
        title="Quick switcher (⌘K)"
      />

      {/* New card 入口在顶部 bar，这里不重复 */}

      <IconButton
        icon={<CalendarDays size={16} />}
        onClick={openToday}
        title="Open today's daily note"
      />

      <IconButton
        icon={<FolderTree size={16} />}
        active={!collapsed && tab === 'vault'}
        onClick={() => onTabClick('vault')}
        title="Vault (indexes / tags / cards)"
      />

      <IconButton
        icon={<Sparkles size={16} />}
        active={!collapsed && tab === 'workspaces'}
        onClick={() => onTabClick('workspaces')}
        title="Workspaces"
      />

      <IconButton
        icon={<Network size={16} />}
        active={activeTabKind === 'graph'}
        onClick={() => openTab({ kind: 'graph', title: 'Graph' })}
        title="Vault graph (zoom to navigate)"
      />

      <div className="flex-1" />

      <IconButton
        icon={<Settings size={16} />}
        active={settingsOpen}
        onClick={() => useUIStore.getState().setSettingsOpen(!settingsOpen)}
        title="Settings (⌘,)"
      />
    </div>
  );
}

function IconButton({
  icon,
  active,
  onClick,
  title,
}: {
  icon: React.ReactNode;
  active?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
        active
          ? 'bg-accent text-white shadow-sm'
          : 'text-gray-500 hover:bg-white hover:text-ink'
      }`}
    >
      {icon}
    </button>
  );
}
