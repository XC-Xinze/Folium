import { FolderTree, PanelLeftClose, PanelLeftOpen, Settings, Sparkles } from 'lucide-react';
import { useUIStore } from '../store/uiStore';

/**
 * Obsidian 风的最左竖向 ribbon：图标导航条。
 *   - 折叠按钮（顶部）
 *   - Vault: sidebar 切回 Indexes/Tags/Cards
 *   - Workspaces: sidebar 切到 workspace 列表
 *   - Settings（底部）
 */
export function RibbonBar() {
  const tab = useUIStore((s) => s.sidebarTab);
  const collapsed = useUIStore((s) => s.leftSidebarCollapsed);
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const viewMode = useUIStore((s) => s.viewMode);

  const onTabClick = (t: 'vault' | 'workspaces') => {
    if (collapsed) {
      // 折叠态点 tab → 展开并切到该 tab
      setSidebarTab(t);
    } else if (tab === t) {
      // 已是当前 tab → 折叠
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
        title={collapsed ? '展开侧栏' : '折叠侧栏'}
      />

      <div className="w-6 border-t border-gray-300 my-1" />

      <IconButton
        icon={<FolderTree size={16} />}
        active={!collapsed && tab === 'vault'}
        onClick={() => onTabClick('vault')}
        title="Vault（索引/标签/卡片）"
      />

      <IconButton
        icon={<Sparkles size={16} />}
        active={!collapsed && tab === 'workspaces'}
        onClick={() => onTabClick('workspaces')}
        title="工作区"
      />

      <div className="flex-1" />

      <IconButton
        icon={<Settings size={16} />}
        active={viewMode === 'settings'}
        onClick={() => setViewMode(viewMode === 'settings' ? 'chain' : 'settings')}
        title="设置"
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
