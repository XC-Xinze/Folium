import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RibbonBar } from './components/RibbonBar';
import { Sidebar } from './components/Sidebar';
import { WorkspacesSidebar } from './components/WorkspacesSidebar';
import { Canvas } from './components/Canvas';
import { Dialog } from './components/Dialog';
import { QuickSwitcher } from './components/QuickSwitcher';
import { NewCardBar } from './components/NewCardBar';
import { SettingsView } from './components/SettingsView';
import { Splitter } from './components/Splitter';
import { TagView } from './components/TagView';
import { WorkspaceView } from './components/WorkspaceView';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { useUIStore } from './store/uiStore';
import { api } from './lib/api';
import { dialog } from './lib/dialog';
import { registerCommand, useGlobalCommands } from './lib/commands';

export function App() {
  const focusedId = useUIStore((s) => s.focusedCardId);
  const focusedBoxId = useUIStore((s) => s.focusedBoxId);
  const focusedTag = useUIStore((s) => s.focusedTag);
  const focusedWorkspaceId = useUIStore((s) => s.focusedWorkspaceId);
  const workspaceFullscreen = useUIStore((s) => s.workspaceFullscreen);
  const workspacePanelPosition = useUIStore((s) => s.workspacePanelPosition);
  const workspacePanelSize = useUIStore((s) => s.workspacePanelSize);
  const setWorkspacePanelSize = useUIStore((s) => s.setWorkspacePanelSize);
  const leftSidebarCollapsed = useUIStore((s) => s.leftSidebarCollapsed);
  const sidebarTab = useUIStore((s) => s.sidebarTab);
  const setBoxAndFocus = useUIStore((s) => s.setBoxAndFocus);
  const viewMode = useUIStore((s) => s.viewMode);
  const theme = useUIStore((s) => s.theme);

  // 主题应用：把 .dark class 加到 <html> 上，auto 模式跟随 prefers-color-scheme
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark =
        theme === 'dark' ||
        (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.classList.toggle('dark', dark);
    };
    apply();
    if (theme !== 'auto') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const indexesQ = useQuery({ queryKey: ['indexes'], queryFn: api.listIndexes });

  useEffect(() => {
    if (focusedId) return;
    const firstIndex = indexesQ.data?.tree[0]?.luhmannId;
    const firstCard = cardsQ.data?.cards[0]?.luhmannId;
    const first = firstIndex ?? firstCard;
    if (first) setBoxAndFocus(first);
  }, [focusedId, indexesQ.data, cardsQ.data, setBoxAndFocus]);

  // 全局命令系统：注册 built-in 命令 + 启动唯一的 keydown 监听
  const qc = useQueryClient();
  const setQuickSwitcherOpen = useUIStore((s) => s.setQuickSwitcherOpen);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar);

  // 注册命令——组件挂载/卸载时进出注册表。focusedId / qc 变化时重新注册
  // 让闭包捕获最新值。
  useEffect(() => {
    const cleanups = [
      registerCommand({
        id: 'card.delete',
        title: 'Delete focused card',
        defaultShortcut: 'Mod+Backspace',
        group: 'Card',
        run: () => {
          if (!focusedId) return;
          void (async () => {
            const ok = await dialog.confirm(`Delete ${focusedId}?`, {
              title: 'Delete card',
              description:
                'The .md file will be removed and references from other cards cleaned up.',
              confirmLabel: 'Delete',
              variant: 'danger',
            });
            if (!ok) return;
            try {
              await api.deleteCard(focusedId);
              qc.invalidateQueries({ queryKey: ['cards'] });
              qc.invalidateQueries({ queryKey: ['indexes'] });
              qc.invalidateQueries({ queryKey: ['positions'] });
              qc.invalidateQueries({ queryKey: ['tags'] });
              qc.invalidateQueries({ queryKey: ['workspaces'] });
            } catch (err) {
              dialog.alert((err as Error).message, { title: 'Delete failed' });
            }
          })();
        },
      }),
      registerCommand({
        id: 'app.quickSwitcher',
        title: 'Open quick switcher',
        defaultShortcut: 'Mod+k',
        group: 'Navigation',
        allowInInput: true, // ⌘K 即使在输入框里也要响应
        run: () => setQuickSwitcherOpen(true),
      }),
      registerCommand({
        id: 'app.dailyNote',
        title: "Open today's daily note",
        defaultShortcut: 'Mod+Shift+d',
        group: 'Navigation',
        run: async () => {
          try {
            const { luhmannId, created } = await api.openOrCreateDaily();
            if (created) {
              qc.invalidateQueries({ queryKey: ['cards'] });
              qc.invalidateQueries({ queryKey: ['indexes'] });
              qc.invalidateQueries({ queryKey: ['tags'] });
            }
            useUIStore.getState().setBoxAndFocus(luhmannId, luhmannId);
          } catch (err) {
            dialog.alert((err as Error).message, { title: 'Daily note failed' });
          }
        },
      }),
      registerCommand({
        id: 'view.toggleSidebar',
        title: 'Toggle left sidebar',
        defaultShortcut: 'Mod+b',
        group: 'View',
        run: () => toggleLeftSidebar(),
      }),
      registerCommand({
        id: 'view.settings',
        title: 'Open settings',
        defaultShortcut: 'Mod+,',
        group: 'View',
        run: () => setViewMode('settings'),
      }),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, [focusedId, qc, setQuickSwitcherOpen, setViewMode, toggleLeftSidebar]);

  useGlobalCommands();

  void focusedBoxId;

  const showWorkspacePanel = !!focusedWorkspaceId;
  const showMain = !workspaceFullscreen || !showWorkspacePanel;

  // 主 + workspace 的 split 布局：方向 + 顺序
  const isHorizontal =
    workspacePanelPosition === 'left' || workspacePanelPosition === 'right';
  const wsBefore =
    workspacePanelPosition === 'left' || workspacePanelPosition === 'top';

  const mainArea = showMain ? (
    <div
      className="flex flex-col min-w-0 min-h-0"
      style={{
        flex: showWorkspacePanel && !workspaceFullscreen ? `1 1 ${100 - workspacePanelSize}%` : '1 1 100%',
      }}
    >
      <NewCardBar />
      <div className="flex-1 relative min-h-0">
        {viewMode === 'tag' && focusedTag ? (
          <TagView tag={focusedTag} />
        ) : focusedBoxId && focusedId ? (
          <Canvas focusedBoxId={focusedBoxId} focusedCardId={focusedId} />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-gray-400">
            {cardsQ.isLoading ? 'Loading cards…' : 'Select a card from the sidebar to start'}
          </div>
        )}
      </div>
    </div>
  ) : null;

  const wsBorderClass = (() => {
    if (workspaceFullscreen) return '';
    switch (workspacePanelPosition) {
      case 'right':
        return 'border-l border-gray-200';
      case 'left':
        return 'border-r border-gray-200';
      case 'top':
        return 'border-b border-gray-200';
      case 'bottom':
        return 'border-t border-gray-200';
    }
  })();

  const workspaceArea = showWorkspacePanel && focusedWorkspaceId ? (
    <aside
      className={`flex flex-col bg-white min-w-0 min-h-0 ${wsBorderClass}`}
      style={{
        flex: workspaceFullscreen ? '1 1 100%' : `1 1 ${workspacePanelSize}%`,
        minWidth: workspaceFullscreen ? 0 : isHorizontal ? 360 : undefined,
        minHeight: workspaceFullscreen ? 0 : !isHorizontal ? 280 : undefined,
      }}
    >
      <WorkspaceView workspaceId={focusedWorkspaceId} />
    </aside>
  ) : null;

  return (
    <div className="h-screen flex">
      <RibbonBar />
      {!leftSidebarCollapsed && (sidebarTab === 'workspaces' ? <WorkspacesSidebar /> : <Sidebar />)}

      <main className="flex-1 flex flex-col bg-[#fafafa] dark:bg-[#24273a] min-w-0">
        <div className="flex items-center justify-end px-6 pt-4 pb-1 border-b border-gray-100/60 dark:border-[#363a4f]/60 bg-[#fafafa] dark:bg-[#24273a]">
          <WorkspaceSwitcher />
        </div>

        {viewMode === 'settings' ? (
          <div className="overflow-y-auto h-full">
            <SettingsView />
          </div>
        ) : (
          <SplitContainer
            isHorizontal={isHorizontal}
            wsBefore={wsBefore}
            showSplitter={showWorkspacePanel && showMain && !workspaceFullscreen}
            workspacePanelPosition={workspacePanelPosition}
            onSplitterResize={setWorkspacePanelSize}
            mainArea={mainArea}
            workspaceArea={workspaceArea}
          />
        )}
      </main>
      <Dialog />
      <QuickSwitcher />
    </div>
  );
}

function SplitContainer({
  isHorizontal,
  wsBefore,
  showSplitter,
  workspacePanelPosition,
  onSplitterResize,
  mainArea,
  workspaceArea,
}: {
  isHorizontal: boolean;
  wsBefore: boolean;
  showSplitter: boolean;
  workspacePanelPosition: 'left' | 'right' | 'top' | 'bottom';
  onSplitterResize: (n: number) => void;
  mainArea: React.ReactNode;
  workspaceArea: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={containerRef}
      className={`flex-1 flex min-h-0 ${isHorizontal ? 'flex-row' : 'flex-col'}`}
    >
      {wsBefore ? workspaceArea : null}
      {wsBefore && showSplitter && (
        <Splitter
          position={workspacePanelPosition}
          containerRef={containerRef}
          onSizeChange={onSplitterResize}
        />
      )}
      {mainArea}
      {!wsBefore && showSplitter && (
        <Splitter
          position={workspacePanelPosition}
          containerRef={containerRef}
          onSizeChange={onSplitterResize}
        />
      )}
      {!wsBefore ? workspaceArea : null}
    </div>
  );
}
