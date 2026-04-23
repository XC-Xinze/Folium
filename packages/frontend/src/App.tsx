import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { Canvas } from './components/Canvas';
import { NewCardBar } from './components/NewCardBar';
import { SettingsView } from './components/SettingsView';
import { TagView } from './components/TagView';
import { WorkspaceView } from './components/WorkspaceView';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { useUIStore } from './store/uiStore';
import { api } from './lib/api';

export function App() {
  const focusedId = useUIStore((s) => s.focusedCardId);
  const focusedBoxId = useUIStore((s) => s.focusedBoxId);
  const focusedTag = useUIStore((s) => s.focusedTag);
  const focusedWorkspaceId = useUIStore((s) => s.focusedWorkspaceId);
  const workspaceFullscreen = useUIStore((s) => s.workspaceFullscreen);
  const leftSidebarCollapsed = useUIStore((s) => s.leftSidebarCollapsed);
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar);
  const setBoxAndFocus = useUIStore((s) => s.setBoxAndFocus);
  const viewMode = useUIStore((s) => s.viewMode);

  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const indexesQ = useQuery({ queryKey: ['indexes'], queryFn: api.listIndexes });

  useEffect(() => {
    if (focusedId) return;
    const firstIndex = indexesQ.data?.tree[0]?.luhmannId;
    const firstCard = cardsQ.data?.cards[0]?.luhmannId;
    const first = firstIndex ?? firstCard;
    if (first) setBoxAndFocus(first);
  }, [focusedId, indexesQ.data, cardsQ.data, setBoxAndFocus]);

  void focusedBoxId;

  const showWorkspacePanel = !!focusedWorkspaceId;
  const showMain = !workspaceFullscreen || !showWorkspacePanel;

  return (
    <div className="h-screen flex">
      {/* 左 sidebar 可折叠 */}
      {!leftSidebarCollapsed && <Sidebar />}

      {/* 折叠柄：永远在最左侧细条上 */}
      <button
        onClick={toggleLeftSidebar}
        className="w-3 hover:bg-gray-100 flex items-center justify-center text-gray-300 hover:text-gray-600 border-r border-gray-100 transition-colors"
        title={leftSidebarCollapsed ? '展开左侧栏' : '折叠左侧栏'}
      >
        {leftSidebarCollapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>

      {/* 主列：顶部条 + 内容（split / fullscreen） */}
      <main className="flex-1 flex flex-col bg-[#fafafa] min-w-0">
        {/* 顶部细条：workspace switcher 永远在 */}
        <div className="flex items-center justify-end px-6 pt-4 pb-1 border-b border-gray-100/60 bg-[#fafafa]">
          <WorkspaceSwitcher />
        </div>

        {viewMode === 'settings' ? (
          <div className="overflow-y-auto h-full">
            <SettingsView />
          </div>
        ) : (
          <div className="flex-1 flex min-h-0">
            {/* 主视图（vault 区） */}
            {showMain && (
              <div className="flex-1 flex flex-col min-w-0">
                <NewCardBar />
                <div className="flex-1 relative min-h-0">
                  {viewMode === 'tag' && focusedTag ? (
                    <TagView tag={focusedTag} />
                  ) : focusedBoxId && focusedId ? (
                    <Canvas focusedBoxId={focusedBoxId} focusedCardId={focusedId} />
                  ) : (
                    <div className="h-full flex items-center justify-center text-sm text-gray-400">
                      {cardsQ.isLoading ? '加载卡片库…' : '左侧选择一张卡片开始'}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 右 workspace 面板（split / fullscreen） */}
            {showWorkspacePanel && focusedWorkspaceId && (
              <aside
                className={`${
                  workspaceFullscreen
                    ? 'flex-1 min-w-0'
                    : 'w-[45%] min-w-[420px] border-l border-gray-200'
                } flex flex-col bg-white`}
              >
                <WorkspaceView workspaceId={focusedWorkspaceId} />
              </aside>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
