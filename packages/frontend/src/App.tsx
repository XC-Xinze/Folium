import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RibbonBar } from './components/RibbonBar';
import { Sidebar } from './components/Sidebar';
import { WorkspacesSidebar } from './components/WorkspacesSidebar';
import { Dialog } from './components/Dialog';
import { QuickSwitcher } from './components/QuickSwitcher';
import { SettingsModal } from './components/SettingsModal';
import { CreateCardModal } from './components/CreateCardModal';
import { CommandPalette } from './components/CommandPalette';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { EmptyVault } from './components/EmptyVault';
import { PaneRoot } from './components/PaneRoot';
import { useIsMobile } from './lib/useIsMobile';
import { useUIStore } from './store/uiStore';
import { usePaneStore } from './store/paneStore';
import { api } from './lib/api';
import { dialog } from './lib/dialog';
import { registerCommand, useGlobalCommands } from './lib/commands';
import { loadAllPlugins } from './lib/pluginLoader';
import { usePaneBootstrap, usePaneSync, useStaleTabCleanup } from './lib/usePaneSync';

export function App() {
  const focusedId = useUIStore((s) => s.focusedCardId);
  const leftSidebarCollapsed = useUIStore((s) => s.leftSidebarCollapsed);
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar);
  const sidebarTab = useUIStore((s) => s.sidebarTab);
  const isMobile = useIsMobile();
  const theme = useUIStore((s) => s.theme);

  // 把 active tab 同步到 uiStore（让老组件继续工作）+ 空 pane 启动种子 + 清持久化脏数据
  usePaneSync();
  usePaneBootstrap();
  useStaleTabCleanup();

  // Mobile：默认折叠 sidebar
  useEffect(() => {
    if (isMobile && !leftSidebarCollapsed) {
      if (!sessionStorage.getItem('mobile-sidebar-init')) {
        toggleLeftSidebar();
        sessionStorage.setItem('mobile-sidebar-init', '1');
      }
    }
  }, [isMobile, leftSidebarCollapsed, toggleLeftSidebar]);

  // 启动时加载用户插件
  useEffect(() => {
    void loadAllPlugins().catch((err) => console.error('plugin load failed', err));
  }, []);

  // 主题应用
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

  // 全局命令系统
  const qc = useQueryClient();
  const setQuickSwitcherOpen = useUIStore((s) => s.setQuickSwitcherOpen);

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
              // 清掉指向已删卡片的 tab —— 不然 active 那张会变 404
              usePaneStore.getState().removeTabsWhere(
                (t) => t.kind === 'card' && (t.cardBoxId === focusedId || t.cardFocusId === focusedId),
              );
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
        allowInInput: true,
        run: () => setQuickSwitcherOpen(true),
      }),
      registerCommand({
        id: 'app.commandPalette',
        title: 'Open command palette',
        defaultShortcut: 'Mod+p',
        group: 'Navigation',
        allowInInput: true,
        run: () => useUIStore.getState().setCommandPaletteOpen(true),
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
            usePaneStore.getState().openTab({
              kind: 'card',
              title: `Daily ${luhmannId}`,
              cardBoxId: luhmannId,
              cardFocusId: luhmannId,
            });
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
        id: 'card.new',
        title: 'Create new card',
        defaultShortcut: 'Mod+n',
        group: 'Card',
        run: () => useUIStore.getState().setNewCardOpen(true),
      }),
      registerCommand({
        id: 'view.settings',
        title: 'Open settings',
        defaultShortcut: 'Mod+,',
        group: 'View',
        run: () => useUIStore.getState().setSettingsOpen(true),
      }),
      registerCommand({
        id: 'view.graph',
        title: 'Open graph',
        defaultShortcut: 'Mod+g',
        group: 'View',
        run: () => usePaneStore.getState().openTab({ kind: 'graph', title: 'Graph' }),
      }),
      registerCommand({
        id: 'view.splitRight',
        title: 'Split active pane right',
        defaultShortcut: 'Mod+\\',
        group: 'View',
        run: () => splitActivePane('horizontal'),
      }),
      registerCommand({
        id: 'view.splitDown',
        title: 'Split active pane down',
        defaultShortcut: 'Mod+Shift+\\',
        group: 'View',
        run: () => splitActivePane('vertical'),
      }),
      registerCommand({
        id: 'tab.close',
        title: 'Close active tab',
        defaultShortcut: 'Mod+w',
        group: 'Tab',
        run: () => usePaneStore.getState().closeActiveTab(),
      }),
      registerCommand({
        id: 'tab.reopen',
        title: 'Reopen recently closed tab',
        defaultShortcut: 'Mod+Shift+t',
        group: 'Tab',
        run: () => usePaneStore.getState().reopenLastClosed(),
      }),
      registerCommand({
        id: 'tab.back',
        title: 'Go back in active tab history',
        defaultShortcut: 'Mod+[',
        group: 'Tab',
        run: () => {
          const { root, activeLeafId, goBackInTab } = usePaneStore.getState();
          function find(n: typeof root): typeof root | null {
            if (n.kind === 'leaf') return n.id === activeLeafId ? n : null;
            for (const c of n.children) {
              const r = find(c);
              if (r) return r;
            }
            return null;
          }
          const leaf = find(root);
          if (leaf?.kind === 'leaf' && leaf.activeTabId) {
            goBackInTab(leaf.id, leaf.activeTabId);
          }
        },
      }),
      registerCommand({
        id: 'tab.forward',
        title: 'Go forward in active tab history',
        defaultShortcut: 'Mod+]',
        group: 'Tab',
        run: () => {
          const { root, activeLeafId, goForwardInTab } = usePaneStore.getState();
          function find(n: typeof root): typeof root | null {
            if (n.kind === 'leaf') return n.id === activeLeafId ? n : null;
            for (const c of n.children) {
              const r = find(c);
              if (r) return r;
            }
            return null;
          }
          const leaf = find(root);
          if (leaf?.kind === 'leaf' && leaf.activeTabId) {
            goForwardInTab(leaf.id, leaf.activeTabId);
          }
        },
      }),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
        registerCommand({
          id: `tab.select${n}`,
          title: `Switch to tab ${n}`,
          defaultShortcut: `Mod+${n}`,
          group: 'Tab',
          run: () => usePaneStore.getState().selectTabAt(n - 1),
        }),
      ),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, [focusedId, qc, setQuickSwitcherOpen, toggleLeftSidebar]);

  useGlobalCommands();

  const sidebarOpen = !leftSidebarCollapsed;
  const isVaultEmpty = cardsQ.data && cardsQ.data.cards.length === 0;

  return (
    <div className="h-screen flex relative">
      <RibbonBar />
      {sidebarOpen && (
        <>
          <div
            className={
              isMobile
                ? 'fixed inset-y-0 left-12 z-40 w-72 max-w-[85vw] shadow-2xl'
                : 'contents'
            }
          >
            {sidebarTab === 'workspaces' ? <WorkspacesSidebar /> : <Sidebar />}
          </div>
          {isMobile && (
            <div
              className="fixed inset-0 z-30 bg-black/30"
              onClick={() => toggleLeftSidebar()}
            />
          )}
        </>
      )}

      <main className="flex-1 flex flex-col bg-[#fafafa] dark:bg-[#24273a] min-w-0">
        <div className="flex items-center gap-2 px-4 pt-2 pb-1 border-b border-gray-100/60 dark:border-[#363a4f]/60 bg-[#fafafa] dark:bg-[#24273a] shrink-0">
          <button
            onClick={() => useUIStore.getState().setNewCardOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent text-white text-[12px] font-bold hover:bg-accent/90 shadow-sm"
            title="New card (⌘N)"
          >
            <span className="text-[14px] leading-none">+</span>
            <span>New card</span>
          </button>
          <div className="flex-1" />
          <WorkspaceSwitcher />
        </div>
        {isVaultEmpty ? <EmptyVault /> : <PaneRoot />}
      </main>
      <Dialog />
      <QuickSwitcher />
      <SettingsModal />
      <CreateCardModal />
      <CommandPalette />
    </div>
  );
}

/** split active pane —— 把当前 active tab 复制到新 pane，避免出空 pane */
function splitActivePane(direction: 'horizontal' | 'vertical') {
  const { root, activeLeafId, splitPane } = usePaneStore.getState();
  function find(node: typeof root): typeof root | null {
    if (node.kind === 'leaf') return node.id === activeLeafId ? node : null;
    for (const c of node.children) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  }
  const leaf = find(root);
  if (!leaf || leaf.kind !== 'leaf') return;
  const at = leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? leaf.tabs[0];
  if (!at) {
    splitPane(activeLeafId, direction);
    return;
  }
  const { id: _id, ...spec } = at;
  void _id;
  splitPane(activeLeafId, direction, spec);
}
