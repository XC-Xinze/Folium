import { lazy, Suspense, useCallback, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, GripVertical, Network, Settings, SplitSquareHorizontal, SplitSquareVertical, Tag, X, XSquare } from 'lucide-react';
import { Canvas } from './Canvas';
import { usePaneStore, type LeafPane, type Pane, type SplitPane, type Tab } from '../store/paneStore';

/**
 * 跨 pane 拖 tab 的 dataTransfer mime 类型 + 序列化协议
 */
const TAB_DRAG_MIME = 'application/x-zk-tab';

interface TabDragData {
  fromPaneId: string;
  tabId: string;
}

function readTabDrag(e: React.DragEvent): TabDragData | null {
  const raw = e.dataTransfer.getData(TAB_DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TabDragData;
  } catch {
    return null;
  }
}

function isTabDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(TAB_DRAG_MIME);
}

/**
 * 根据光标在 pane 内的相对位置算出"边缘 split 区"或"中心 move 区"。
 * 边缘阈值：距某边 < 25% 算那一边。
 */
type DropZone = 'top' | 'bottom' | 'left' | 'right' | 'center' | null;

function pickDropZone(rect: DOMRect, x: number, y: number): DropZone {
  const dx = x - rect.left;
  const dy = y - rect.top;
  const fx = dx / rect.width;
  const fy = dy / rect.height;
  const EDGE = 0.25;
  // 优先按"距哪条边最近"判，避免角上同时命中两边
  const distLeft = fx;
  const distRight = 1 - fx;
  const distTop = fy;
  const distBottom = 1 - fy;
  const minDist = Math.min(distLeft, distRight, distTop, distBottom);
  if (minDist > EDGE) return 'center';
  if (minDist === distLeft) return 'left';
  if (minDist === distRight) return 'right';
  if (minDist === distTop) return 'top';
  return 'bottom';
}

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
  const moveTab = usePaneStore((s) => s.moveTab);
  const moveTabToSplit = usePaneStore((s) => s.moveTabToSplit);
  const isActive = activeLeafId === pane.id;
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [zone, setZone] = useState<DropZone>(null);

  const onBodyDragOver = (e: React.DragEvent) => {
    if (!isTabDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return;
    setZone(pickDropZone(rect, e.clientX, e.clientY));
  };
  const onBodyDragLeave = (e: React.DragEvent) => {
    // 离开 pane 边界时才清；冒泡内部子元素 leave 不算
    if (e.currentTarget === e.target) setZone(null);
  };
  const onBodyDrop = (e: React.DragEvent) => {
    const data = readTabDrag(e);
    if (!data) return;
    e.preventDefault();
    const z = zone;
    setZone(null);
    if (!z) return;
    if (z === 'center') {
      // append 到本 pane（已存在则去重）
      moveTab(data.fromPaneId, data.tabId, pane.id);
    } else {
      moveTabToSplit(data.fromPaneId, data.tabId, pane.id, z);
    }
  };

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
      <div
        ref={bodyRef}
        onDragOver={onBodyDragOver}
        onDragLeave={onBodyDragLeave}
        onDrop={onBodyDrop}
        className="flex-1 relative min-h-0"
      >
        {activeTab ? (
          <TabContent tab={activeTab} paneId={pane.id} />
        ) : (
          <EmptyTabHint paneId={pane.id} />
        )}
        {/* 拖拽时的 drop zone overlay —— 只在有目标区时显示 */}
        {zone && <DropZoneOverlay zone={zone} />}
      </div>
    </div>
  );
}

/** 拖 tab 时显示的高亮预览：center/edge 都能看到落点 */
function DropZoneOverlay({ zone }: { zone: Exclude<DropZone, null> }) {
  const base = 'absolute z-20 pointer-events-none bg-accent/25 border-2 border-accent/70 rounded';
  switch (zone) {
    case 'center':
      return <div className={`${base} inset-2`} />;
    case 'left':
      return <div className={`${base} left-2 top-2 bottom-2 w-1/2`} />;
    case 'right':
      return <div className={`${base} right-2 top-2 bottom-2 w-1/2`} />;
    case 'top':
      return <div className={`${base} top-2 left-2 right-2 h-1/2`} />;
    case 'bottom':
      return <div className={`${base} bottom-2 left-2 right-2 h-1/2`} />;
  }
}

function TabBar({ pane, isActive }: { pane: LeafPane; isActive: boolean }) {
  const setActiveTab = usePaneStore((s) => s.setActiveTab);
  const closeTab = usePaneStore((s) => s.closeTab);
  const splitPane = usePaneStore((s) => s.splitPane);
  const moveTab = usePaneStore((s) => s.moveTab);
  const root = usePaneStore((s) => s.root);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  // 唯一 leaf 不能关；split 的孩子可以关
  const isOnlyLeaf = root.kind === 'leaf' && root.id === pane.id;
  const closePane = () => {
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
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData(
                TAB_DRAG_MIME,
                JSON.stringify({ fromPaneId: pane.id, tabId: tab.id }),
              );
            }}
            onDragOver={(e) => {
              if (!isTabDrag(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDragOverIdx(i);
            }}
            onDragLeave={() => setDragOverIdx((cur) => (cur === i ? null : cur))}
            onDrop={(e) => {
              const data = readTabDrag(e);
              if (!data) return;
              e.preventDefault();
              e.stopPropagation();
              setDragOverIdx(null);
              moveTab(data.fromPaneId, data.tabId, pane.id, i);
            }}
            onClick={() => setActiveTab(pane.id, tab.id)}
            className={`group relative flex items-center gap-1.5 px-3 cursor-pointer border-r border-gray-100 dark:border-[#363a4f] text-[12px] select-none min-w-0 max-w-[200px] ${
              isActiveTab
                ? 'bg-white dark:bg-[#1e2030] text-ink dark:text-[#cad3f5]'
                : 'bg-gray-100/60 dark:bg-[#24273a] text-gray-500 dark:text-[#a5adcb] hover:bg-gray-100 dark:hover:bg-[#1e2030]'
            }`}
            title={tab.title}
          >
            {dragOverIdx === i && (
              <div className="absolute inset-y-0 left-0 w-0.5 bg-accent z-10 pointer-events-none" />
            )}
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
  const updateTab = usePaneStore((s) => s.updateTab);
  switch (tab.kind) {
    case 'card':
      if (tab.cardBoxId && tab.cardFocusId) {
        return (
          <Canvas
            focusedBoxId={tab.cardBoxId}
            focusedCardId={tab.cardFocusId}
            flags={tab.cardFlags}
            onFlagChange={(key, value) =>
              updateTab(paneId, tab.id, {
                cardFlags: { ...(tab.cardFlags ?? {}), [key]: value },
              })
            }
          />
        );
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
