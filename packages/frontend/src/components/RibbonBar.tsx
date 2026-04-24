import { FolderTree, PanelLeftClose, PanelLeftOpen, Search, Settings, Sparkles } from 'lucide-react';
import { useUIStore } from '../store/uiStore';

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
  const setViewMode = useUIStore((s) => s.setViewMode);
  const viewMode = useUIStore((s) => s.viewMode);
  const setQuickSwitcherOpen = useUIStore((s) => s.setQuickSwitcherOpen);

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
    <div className="w-12 bg-[#f3f3f1] border-r border-gray-200 flex flex-col items-center py-2 gap-1 shrink-0">
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

      <div className="flex-1" />

      <IconButton
        icon={<Settings size={16} />}
        active={viewMode === 'settings'}
        onClick={() => setViewMode(viewMode === 'settings' ? 'chain' : 'settings')}
        title="Settings"
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
