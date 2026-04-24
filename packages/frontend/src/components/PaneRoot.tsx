import { lazy, Suspense, useCallback, useRef, type ReactNode } from 'react';
import { ChevronDown, GripVertical, Network, Settings, SplitSquareHorizontal, SplitSquareVertical, Tag, X, XSquare } from 'lucide-react';
import { Canvas } from './Canvas';
import { usePaneStore, type LeafPane, type Pane, type SplitPane, type Tab } from '../store/paneStore';

const SettingsView = lazy(() =>
  import('./SettingsView').then((m) => ({ default: m.SettingsView })),
);
const TagView = lazy(() =>
  import('./TagView').then((m) => ({ default: m.TagView })),
);
const WorkspaceView = lazy(() =>
  import('./WorkspaceView').then((m) => ({ default: m.WorkspaceView })),
);
const GraphView = lazy(() =>
  import('./GraphView').then((m) => ({ default: m.GraphView })),
);

/**
 * Pane 树渲染入口。递归地把 SplitPane 拆成左右/上下两块，LeafPane 渲染 TabBar + 当前 tab 内容。
 */
export function PaneRoot() {
  const root = usePaneStore((s) => s.root);
  return (
    <div className="flex-1 flex min-h-0 min-w-0 bg-[#fafafa] dark:bg-[#24273a]">
      <PaneNode pane={root} />
    </div>
  );
}

function PaneNode({ pane }: { pane: Pane }) {
  if (pane.kind === 'leaf') return <LeafPaneView pane={pane} />;
  return <SplitPaneView pane={pane} />;
}

function SplitPaneView({ pane }: { pane: SplitPane }) {
  const setRatio = usePaneStore((s) => s.setRatio);
  const ref = useRef<HTMLDivElement>(null);
  const isHorizontal = pane.direction === 'horizontal';

  const onSplitterDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const prevSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';

      const onMove = (ev: MouseEvent) => {
        const r = ref.current?.getBoundingClientRect();
        if (!r) return;
        const ratio = isHorizontal
          ? (ev.clientX - r.left) / r.width
          : (ev.clientY - r.top) / r.height;
        setRatio(pane.id, ratio);
      };
      const onUp = () => {
        document.body.style.userSelect = prevSelect;
        document.body.style.cursor = prevCursor;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [pane.id, isHorizontal, setRatio],
  );

  return (
    <div
      ref={ref}
      className={`flex-1 flex min-h-0 min-w-0 ${isHorizontal ? 'flex-row' : 'flex-col'}`}
    >
      <div
        className="min-h-0 min-w-0 flex"
        style={{ flex: `${pane.ratio} 1 0` }}
      >
        <PaneNode pane={pane.children[0]} />
      </div>
      <div
        onMouseDown={onSplitterDown}
        className={`shrink-0 bg-gray-200 dark:bg-[#363a4f] hover:bg-accent transition-colors ${
          isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
        }`}
        title="Drag to resize"
      />
      <div
        className="min-h-0 min-w-0 flex"
        style={{ flex: `${1 - pane.ratio} 1 0` }}
      >
        <PaneNode pane={pane.children[1]} />
      </div>
    </div>
  );
}

function LeafPaneView({ pane }: { pane: LeafPane }) {
  const setActiveLeaf = usePaneStore((s) => s.setActiveLeaf);
  const activeLeafId = usePaneStore((s) => s.activeLeafId);
  const isActive = activeLeafId === pane.id;
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;

  return (
    <div
      onMouseDownCapture={() => {
        if (!isActive) setActiveLeaf(pane.id);
      }}
      className={`flex-1 flex flex-col min-h-0 min-w-0 ${
        isActive ? '' : 'opacity-95'
      }`}
    >
      <TabBar pane={pane} isActive={isActive} />
      <div className="flex-1 relative min-h-0">
        {activeTab ? (
          <TabContent tab={activeTab} paneId={pane.id} />
        ) : (
          <EmptyTabHint paneId={pane.id} />
        )}
      </div>
    </div>
  );
}

function TabBar({ pane, isActive }: { pane: LeafPane; isActive: boolean }) {
  const setActiveTab = usePaneStore((s) => s.setActiveTab);
  const closeTab = usePaneStore((s) => s.closeTab);
  const splitPane = usePaneStore((s) => s.splitPane);
  const reorderTab = usePaneStore((s) => s.reorderTab);
  const root = usePaneStore((s) => s.root);
  const dragIdxRef = useRef<number | null>(null);
  // 唯一 leaf 不能关；split 的孩子可以关
  const isOnlyLeaf = root.kind === 'leaf' && root.id === pane.id;
  // 关空 pane：直接走 closeTab(_, '__phantom__') 走不通 —— 改用 setRoot via removeLeaf
  // 简化：派一个虚拟 tabId 给 closeTab —— 它会走"找不到 tab 直接 return"
  // 真正关：fake 一个 tab 然后立刻关掉。或者用一个专门的 closePane action。
  const closePane = () => {
    // 直接调 closeTab on 'sentinel' 不会触发删除。我们走"先确保 tabs 列表有内容才关"
    // 简单做法：如果还有 tab，逐个关；如果没 tab，调用 closeTab on 一个不存在的 id（无 op）
    // 实际上 closeTab 在 tabs 为 0 时不会进 remaining 分支 —— 它直接 return（findIndex < 0）
    // 所以我们需要一个新的"closePane"动作。临时做法：先 push 个空 tab 再关它。
    // 改：直接调用一个新方法 removeEmptyPane（下面在 store 里加）
    usePaneStore.getState().removeEmptyPane(pane.id);
  };

  return (
    <div
      className={`shrink-0 flex items-stretch h-9 border-b ${
        isActive
          ? 'bg-white dark:bg-[#1e2030] border-gray-200 dark:border-[#363a4f]'
          : 'bg-gray-50 dark:bg-[#181926] border-gray-100 dark:border-[#363a4f]'
      } overflow-x-auto`}
    >
      {pane.tabs.map((tab, i) => {
        const isActiveTab = tab.id === pane.activeTabId;
        return (
          <div
            key={tab.id}
            draggable
            onDragStart={(e) => {
              dragIdxRef.current = i;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('application/x-zk-tab', String(i));
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-zk-tab')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }
            }}
            onDrop={(e) => {
              const fromStr = e.dataTransfer.getData('application/x-zk-tab');
              if (!fromStr) return;
              const from = Number(fromStr);
              if (!Number.isFinite(from)) return;
              e.preventDefault();
              reorderTab(pane.id, from, i);
            }}
            onClick={() => setActiveTab(pane.id, tab.id)}
            className={`group relative flex items-center gap-1.5 px-3 cursor-pointer border-r border-gray-100 dark:border-[#363a4f] text-[12px] select-none min-w-0 max-w-[200px] ${
              isActiveTab
                ? 'bg-white dark:bg-[#1e2030] text-ink dark:text-[#cad3f5]'
                : 'bg-gray-100/60 dark:bg-[#24273a] text-gray-500 dark:text-[#a5adcb] hover:bg-gray-100 dark:hover:bg-[#1e2030]'
            }`}
            title={tab.title}
          >
            <TabIcon tab={tab} />
            <span className="truncate">{tab.title || '(untitled)'}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(pane.id, tab.id);
              }}
              className="ml-1 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-[#494d64] opacity-0 group-hover:opacity-100"
              title="Close tab"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
      <div className="flex-1" />
      {pane.tabs.length > 0 && (
        <>
          <button
            onClick={() => splitPane(pane.id, 'horizontal')}
            className="px-2 text-gray-400 hover:text-ink dark:hover:text-[#cad3f5] hover:bg-gray-100 dark:hover:bg-[#363a4f]"
            title="Split right"
          >
            <SplitSquareHorizontal size={12} />
          </button>
          <button
            onClick={() => splitPane(pane.id, 'vertical')}
            className="px-2 text-gray-400 hover:text-ink dark:hover:text-[#cad3f5] hover:bg-gray-100 dark:hover:bg-[#363a4f]"
            title="Split down"
          >
            <SplitSquareVertical size={12} />
          </button>
        </>
      )}
      {/* 关闭整个 pane（仅在不是唯一 leaf 时显示） */}
      {!isOnlyLeaf && (
        <button
          onClick={closePane}
          className="px-2 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
          title="Close this pane"
        >
          <XSquare size={12} />
        </button>
      )}
    </div>
  );
}

function TabIcon({ tab }: { tab: Tab }) {
  const cls = 'shrink-0';
  switch (tab.kind) {
    case 'graph':
      return <Network size={11} className={cls} />;
    case 'tag':
      return <Tag size={11} className={cls} />;
    case 'settings':
      return <Settings size={11} className={cls} />;
    case 'workspace':
      return <GripVertical size={11} className={cls} />;
    case 'card':
      return <ChevronDown size={11} className={cls} style={{ visibility: 'hidden' }} />;
  }
}

function TabContent({ tab, paneId }: { tab: Tab; paneId: string }) {
  void paneId;
  switch (tab.kind) {
    case 'card':
      if (tab.cardBoxId && tab.cardFocusId) {
        return <Canvas focusedBoxId={tab.cardBoxId} focusedCardId={tab.cardFocusId} />;
      }
      return <Hint>Card tab missing payload.</Hint>;
    case 'graph':
      return (
        <Suspense fallback={<Hint>Loading graph…</Hint>}>
          <GraphView />
        </Suspense>
      );
    case 'tag':
      if (!tab.tagName) return <Hint>Tag tab missing tagName.</Hint>;
      return (
        <Suspense fallback={<Hint>Loading tag…</Hint>}>
          <TagView tag={tab.tagName} />
        </Suspense>
      );
    case 'settings':
      return (
        <Suspense fallback={<Hint>Loading settings…</Hint>}>
          <div className="overflow-y-auto h-full">
            <SettingsView />
          </div>
        </Suspense>
      );
    case 'workspace':
      if (!tab.workspaceId) return <Hint>Workspace tab missing workspaceId.</Hint>;
      return (
        <Suspense fallback={<Hint>Loading workspace…</Hint>}>
          <WorkspaceView workspaceId={tab.workspaceId} />
        </Suspense>
      );
  }
}

function EmptyTabHint({ paneId }: { paneId: string }) {
  const openTabIn = usePaneStore((s) => s.openTabIn);
  return (
    <div className="h-full flex items-center justify-center text-sm text-gray-400 p-6">
      <div className="text-center space-y-2">
        <div>Empty pane.</div>
        <div className="text-[11px]">
          Click a card in the sidebar, or{' '}
          <button
            className="underline hover:text-accent"
            onClick={() => openTabIn(paneId, { kind: 'graph', title: 'Graph' })}
          >
            open the graph
          </button>
          .
        </div>
      </div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-sm text-gray-400">{children}</div>
  );
}
