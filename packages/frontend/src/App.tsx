import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sidebar } from './components/Sidebar';
import { Canvas } from './components/Canvas';
import { NewCardBar } from './components/NewCardBar';
import { SettingsView } from './components/SettingsView';
import { TagView } from './components/TagView';
import { WorkspaceView } from './components/WorkspaceView';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { useUIStore } from './store/uiStore';
import { api } from './lib/api';

// 自动聚焦：优先 INDEX 卡（顶层），否则任意第一张卡

export function App() {
  const focusedId = useUIStore((s) => s.focusedCardId);
  const focusedBoxId = useUIStore((s) => s.focusedBoxId);
  const focusedTag = useUIStore((s) => s.focusedTag);
  const focusedWorkspaceId = useUIStore((s) => s.focusedWorkspaceId);
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

  void focusedBoxId; // box 状态在 Canvas 里使用

  return (
    <div className="h-screen flex">
      <Sidebar />
      <main className="flex-1 flex flex-col bg-[#fafafa] min-w-0">
        {viewMode === 'settings' ? (
          <div className="overflow-y-auto h-full">
            <SettingsView />
          </div>
        ) : (
          <>
            {/* 顶部细条：workspace 切换器永远可见 */}
            <div className="flex items-center justify-end px-6 pt-4 pb-1 border-b border-gray-100/60 bg-[#fafafa]">
              <WorkspaceSwitcher />
            </div>
            {viewMode !== 'workspace' && <NewCardBar />}
            <div className="flex-1 relative min-h-0">
              {viewMode === 'workspace' && focusedWorkspaceId ? (
                <WorkspaceView workspaceId={focusedWorkspaceId} />
              ) : viewMode === 'tag' && focusedTag ? (
                <TagView tag={focusedTag} />
              ) : focusedBoxId && focusedId ? (
                <Canvas focusedBoxId={focusedBoxId} focusedCardId={focusedId} />
              ) : (
                <div className="h-full flex items-center justify-center text-sm text-gray-400">
                  {cardsQ.isLoading ? '加载卡片库…' : '左侧选择一张卡片开始'}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
