import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Card, type PositionMap } from '../lib/api';
import { dialog } from '../lib/dialog';
import { CardNode } from './CardNode';
import { CrossEdge, PotentialEdge } from './CanvasEdges';
import { applyAnchorPositions, buildGraph, computeBackbone, MASTER_BOX_ID, resolveCollisions } from '../lib/cardGraph';
import { DEFAULT_CARD_FLAGS, usePaneStore as usePaneStoreImported, type CardDisplayFlags } from '../store/paneStore';

const nodeTypes = { card: CardNode };
const edgeTypes = { potential: PotentialEdge, cross: CrossEdge };

interface Props {
  focusedBoxId: string;
  focusedCardId: string;
  /** 每个 tab 自己持有这四个开关 —— 无值就回退到 DEFAULT_CARD_FLAGS */
  flags?: Partial<CardDisplayFlags>;
  /** 切换某一项时回写到 tab payload（PaneRoot 通过 updateTab 实现） */
  onFlagChange?: (key: keyof CardDisplayFlags, value: boolean) => void;
  /** 当前 tab 的探索深度（点了几层外部卡）—— 用于 UI 提示 */
  focusDepth?: number;
}

const MAX_FOCUS_DEPTH = 3;

function CanvasInner({ focusedBoxId, focusedCardId, flags, onFlagChange, focusDepth = 0 }: Props) {
  const merged = { ...DEFAULT_CARD_FLAGS, ...(flags ?? {}) };
  const showPotential = merged.potential;
  const showTagRelated = merged.tag;
  const showCrossLinks = merged.cross;
  const showWorkspaceLinks = merged.workspaceLinks;
  // 没接 onFlagChange 的兜底：原地状态（用于 Canvas 被非 tab 场景用时不挂掉）
  const setFlag = (k: keyof CardDisplayFlags, v: boolean) => onFlagChange?.(k, v);
  const setShowPotential = (v: boolean) => setFlag('potential', v);
  const setShowTagRelated = (v: boolean) => setFlag('tag', v);
  const setShowCrossLinks = (v: boolean) => setFlag('cross', v);
  const setShowWorkspaceLinks = (v: boolean) => setFlag('workspaceLinks', v);
  const qc = useQueryClient();

  const isMaster = focusedBoxId === MASTER_BOX_ID;

  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  // 同时拿 box 和 focus 的完整内容（box 用于 INDEX 展开 cross-link）
  // Master 是虚拟 box，没真卡，跳过。
  const boxQ = useQuery({
    queryKey: ['card', focusedBoxId],
    queryFn: () => api.getCard(focusedBoxId),
    enabled: !isMaster,
  });
  const focusQ = useQuery({
    queryKey: ['card', focusedCardId],
    queryFn: () => api.getCard(focusedCardId),
    enabled: focusedCardId !== focusedBoxId && focusedCardId !== MASTER_BOX_ID,
  });
  const linkedQ = useQuery({
    queryKey: ['linked', focusedBoxId],
    queryFn: () => api.getLinked(focusedBoxId),
    enabled: !isMaster,
  });

  const fullCards = useMemo(() => {
    const m = new Map<string, Card>();
    if (boxQ.data) m.set(boxQ.data.luhmannId, boxQ.data);
    if (focusQ.data) m.set(focusQ.data.luhmannId, focusQ.data);
    for (const c of linkedQ.data?.linked ?? []) m.set(c.luhmannId, c);
    return m;
  }, [boxQ.data, focusQ.data, linkedQ.data]);

  const backboneIds = useMemo(() => {
    if (!cardsQ.data) return [] as string[];
    if (!isMaster && !boxQ.data) return [] as string[]; // 普通 box 等真卡数据
    const bb = computeBackbone(focusedBoxId, cardsQ.data.cards, fullCards);
    return [...bb.ids];
  }, [cardsQ.data, boxQ.data, fullCards, focusedBoxId, isMaster]);

  // Tag trail：本 box 会话期间出现过的、有 tag 的焦点卡集合。
  // Trail 累加：焦点每切到一张有 tag 的卡，把它加进去；
  // 老锚的 tag-related 邻居不消失，新锚的也加进画布。
  // Box 切换 → 重置为 [boxId]。Potential 卡（无 tag）不进 trail。
  const [tagTrailIds, setTagTrailIds] = useState<string[]>(() => [focusedBoxId]);
  // box 切了 → 重置 trail
  useEffect(() => {
    setTagTrailIds([focusedBoxId]);
  }, [focusedBoxId]);
  // 焦点切到一张有 tag 的卡 → 加进 trail（去重）
  useEffect(() => {
    const focusCard = cardsQ.data?.cards.find((c) => c.luhmannId === focusedCardId);
    if (!focusCard || focusCard.tags.length === 0) return;
    setTagTrailIds((prev) => (prev.includes(focusedCardId) ? prev : [...prev, focusedCardId]));
  }, [focusedCardId, cardsQ.data]);

  // 焦点卡若是从外部 tag-related 拉进来的（不在 backbone 里），单独把它加进 relatedBatch
  // 否则它的 tagRelated 拿不到 → buildGraph 退化成"所有 backbone 卡两两连"
  // 同时把 tag trail 全部锚也加进来，保证 buildGraph 能拿到每个锚的 batch 数据
  const relatedIds = useMemo(() => {
    const set = new Set(backboneIds);
    if (focusedCardId) set.add(focusedCardId);
    for (const id of tagTrailIds) set.add(id);
    return [...set];
  }, [backboneIds, focusedCardId, tagTrailIds]);

  // tag-related 是 first-class（默认显示），不受 showPotential 影响——所以总要拉
  // 不用 keepPreviousData：会让旧焦点的 tagRelated 卡住，新焦点的边永远画不出来
  // 接受 fetch 期间 < 100ms 的 tag 边短暂消失
  const relatedBatchQ = useQuery({
    queryKey: ['related-batch', relatedIds],
    queryFn: () => api.relatedBatch(relatedIds, 3),
    enabled: relatedIds.length > 0,
  });

  // 工作区里涉及 backbone 卡片的边：作为 potential 风格的叠加显示在画布上
  const workspaceLinksQ = useQuery({
    queryKey: ['ws-links-batch', backboneIds],
    queryFn: () => api.workspaceLinksBatch(backboneIds),
    enabled: backboneIds.length > 0,
  });

  // 位置按 box 隔离：不同 box 即使是同一张卡，也有各自独立的位置
  const scope = `box:${focusedBoxId}`;
  const positionsQ = useQuery({
    queryKey: ['positions', scope],
    queryFn: () => api.getPositions(scope),
  });

  const graph = useMemo(() => {
    if (!cardsQ.data) return { nodes: [] as Node[], edges: [] as Edge[] };
    if (!isMaster && !boxQ.data) return { nodes: [] as Node[], edges: [] as Edge[] };
    const raw = buildGraph({
      allCards: cardsQ.data.cards,
      fullCards,
      focusedBoxId,
      focusedCardId,
      tagAnchorIds: tagTrailIds,
      relatedBatch: relatedBatchQ.data ?? {},
      // Master 视图：只展示顶级卡的纯净网格，关掉所有关联层
      showPotential: isMaster ? false : showPotential,
      showTagRelated: isMaster ? false : showTagRelated,
      showCrossLinks: isMaster ? false : showCrossLinks,
      workspaceLinks: showWorkspaceLinks && !isMaster ? workspaceLinksQ.data?.links ?? [] : [],
    });
    const anchored = applyAnchorPositions(raw.nodes, raw.edges, positionsQ.data ?? {});
    // 一次性碰撞解算：把自动布局产生的重叠抹掉，但锁定用户手动拖过的位置
    const finalNodes = resolveCollisions(anchored, positionsQ.data ?? {});
    // 把 scope 印到每个节点 data 上，CardNode 直接读，多 pane 同屏不串
    const stamped = finalNodes.map((n) => ({
      ...n,
      data: { ...(n.data as object), scope },
    }));
    return { nodes: stamped, edges: raw.edges };
  }, [
    scope,
    cardsQ.data,
    boxQ.data,
    fullCards,
    focusedBoxId,
    focusedCardId,
    isMaster,
    tagTrailIds,
    relatedBatchQ.data,
    showPotential,
    showTagRelated,
    showCrossLinks,
    showWorkspaceLinks,
    workspaceLinksQ.data,
    positionsQ.data,
  ]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // 切换 box 时清缓存（避免跨 box 的位置串联）；同 box 内切换焦点时保留位置
  const prevBoxRef = useRef(focusedBoxId);
  const prevFocusRef = useRef(focusedCardId);
  // 会话级 sticky 位置缓存：节点已经摆好的位置不被 buildGraph 重排挪动
  const stickyPosRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  useEffect(() => {
    const boxChanged = prevBoxRef.current !== focusedBoxId;
    const focusChanged = prevFocusRef.current !== focusedCardId;
    prevBoxRef.current = focusedBoxId;
    prevFocusRef.current = focusedCardId;
    if (boxChanged) stickyPosRef.current.clear();

    setNodes((prev) => {
      if (boxChanged) {
        for (const n of graph.nodes) stickyPosRef.current.set(n.id, n.position);
        return graph.nodes;
      }
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      // 反复点已经在画布上的卡不会让它跳来跳去：所有节点优先用 sticky/prevPos，
      // 真·首次出现的卡（buildGraph 给的新位置）才用 layout 位置。
      const merged = graph.nodes.map((n) => {
        const cached = prevPos.get(n.id) ?? stickyPosRef.current.get(n.id);
        return cached ? { ...n, position: cached } : n;
      });

      // 焦点切换时 relatedBatch 会 refetch（key 含 focusedCardId），
      // refetch 期间 batch 数据是 undefined → buildGraph 算出的 graph.nodes 临时少了
      // tag-related / cross-flank / potential。这一段会把"prev 有但本次 graph 没有"
      // 的节点暂时保留在画布上，等 batch 回来 graph 重建时再正常 merge。
      // 这样用户连续点外部卡时不会看到 "全部外部卡瞬间消失" 的闪烁。
      if (focusChanged && !boxChanged && relatedBatchQ.isFetching) {
        const currentIds = new Set(merged.map((n) => n.id));
        const carry = prev.filter((n) => !currentIds.has(n.id));
        if (carry.length > 0) merged.push(...carry);
      }

      for (const n of merged) stickyPosRef.current.set(n.id, n.position);
      return merged;
    });
    // 边同理：refetch 期间，把 prev 有但本次 graph 没有的边一并保留，
    // 不然刚才 carry 进来的节点就是孤岛
    setEdges((prev) => {
      if (boxChanged) return graph.edges;
      if (focusChanged && relatedBatchQ.isFetching) {
        const currentEdgeIds = new Set(graph.edges.map((e) => e.id));
        const carry = prev.filter((e) => !currentEdgeIds.has(e.id));
        return carry.length > 0 ? [...graph.edges, ...carry] : graph.edges;
      }
      return graph.edges;
    });
  }, [graph, focusedBoxId, focusedCardId, relatedBatchQ.isFetching, setNodes, setEdges]);

  // 拖拽结束 → 乐观更新 + 异步写磁盘（scope 限定）
  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      if (node.id.startsWith('__')) return;
      // sticky 也更新 —— 下次 buildGraph 重排不会再挪动这个节点
      stickyPosRef.current.set(node.id, { x: node.position.x, y: node.position.y });
      qc.setQueryData<PositionMap>(['positions', scope], (old = {}) => ({
        ...old,
        [node.id]: { x: node.position.x, y: node.position.y },
      }));
      api.setPosition(scope, node.id, node.position.x, node.position.y).catch((err) => {
        console.error('save position failed', err);
      });
    },
    [qc, scope],
  );

  if (cardsQ.isLoading) return <FullCenter>Loading cards…</FullCenter>;
  if (cardsQ.error) return <FullCenter error>{String(cardsQ.error)}</FullCenter>;
  if (!cardsQ.data?.cards.length)
    return <FullCenter>The vault is empty. Drop some .md files in example-vault/ to get started.</FullCenter>;
  // 普通 box 才 gate 在 boxQ 上；master 是虚拟 box 没真卡可拉
  if (!isMaster && boxQ.isLoading) return <FullCenter>Loading box {focusedBoxId}…</FullCenter>;
  if (!isMaster && boxQ.error) return <FullCenter error>Box {focusedBoxId} not found</FullCenter>;

  return (
    <div className="w-full h-full flex flex-col">
      {/* Canvas 顶部工具栏 —— 实色 inline，不再浮动避免分屏时跟其他东西重叠 */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-[#1e2030] border-b border-gray-200 dark:border-[#363a4f] overflow-x-auto">
        <HistoryButtons />
        <span className="w-px h-4 bg-gray-200 dark:bg-[#494d64]" />
        <div className="flex items-center gap-1.5">
          <EdgeToggle color="#7c4dff" label="Link" active={showCrossLinks} onClick={() => setShowCrossLinks(!showCrossLinks)} title="Manual [[link]] edges (purple)" />
          <EdgeToggle color="#10b981" label="Tag" active={showTagRelated} onClick={() => setShowTagRelated(!showTagRelated)} title="Tag co-occurrence edges (green)" />
          <EdgeToggle color="#cbd5e1" label="Potential" active={showPotential} onClick={() => setShowPotential(!showPotential)} title="Text-similarity potential edges (gray dashed)" />
          <EdgeToggle color="#a78bfa" label="Temp" active={showWorkspaceLinks} onClick={() => setShowWorkspaceLinks(!showWorkspaceLinks)} title="Workspace temp ghost cards & their links" />
        </div>
        <span className="w-px h-4 bg-gray-200 dark:bg-[#494d64]" />
        <FocusDepthBadge depth={focusDepth} max={MAX_FOCUS_DEPTH} />
        <div className="flex-1" />
        <AddFocusedToWorkspace focusedCardId={focusedCardId} />
      </div>

      <div className="flex-1 relative min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1, minZoom: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background id={`vault-bg-${focusedBoxId}`} gap={24} size={1.5} color="#e5e7eb" />
          <Controls position="bottom-right" showInteractive={false} />
          <MiniMap pannable zoomable position="top-right" maskColor="rgba(0,0,0,0.05)" />
        </ReactFlow>
      </div>
    </div>
  );
}

function HistoryButtons() {
  // 直接读 active tab 算出能否前进/后退
  const root = usePaneStoreImported((s) => s.root);
  const activeLeafId = usePaneStoreImported((s) => s.activeLeafId);
  function findLeaf(node: typeof root): typeof root | null {
    if (node.kind === 'leaf') return node.id === activeLeafId ? node : null;
    for (const c of node.children) {
      const r = findLeaf(c);
      if (r) return r;
    }
    return null;
  }
  const leaf = findLeaf(root);
  if (leaf?.kind !== 'leaf' || !leaf.activeTabId) return null;
  const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
  if (!tab || tab.kind !== 'card') return null;
  const hist = tab.cardHistory ?? [];
  const idx = tab.cardHistoryIndex ?? -1;
  const canBack = idx > 0;
  const canFwd = idx >= 0 && idx < hist.length - 1;
  const back = () =>
    usePaneStoreImported.getState().goBackInTab(leaf.id, leaf.activeTabId!);
  const forward = () =>
    usePaneStoreImported.getState().goForwardInTab(leaf.id, leaf.activeTabId!);
  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={back}
        disabled={!canBack}
        className="p-0.5 rounded hover:bg-gray-100 dark:hover:bg-[#494d64] disabled:opacity-25 text-gray-600 dark:text-[#cad3f5]"
        title="Back (⌘[)"
      >
        <ChevronLeftHistory />
      </button>
      <button
        onClick={forward}
        disabled={!canFwd}
        className="p-0.5 rounded hover:bg-gray-100 dark:hover:bg-[#494d64] disabled:opacity-25 text-gray-600 dark:text-[#cad3f5]"
        title="Forward (⌘])"
      >
        <ChevronRightHistory />
      </button>
    </div>
  );
}

/**
 * "+ Workspace" 按钮：
 *   - 点击 → 弹出工作区选择器 → 把当前焦点卡加进选中的工作区（或新建）
 *   - 拖拽 → 同样把焦点卡作为 drag payload，可以拖到任意工作区入口
 *   去重：选中的 ws 已经包含这张卡就跳过。
 */
function AddFocusedToWorkspace({ focusedCardId }: { focusedCardId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [popPos, setPopPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const wsQ = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces });
  const list = wsQ.data?.workspaces ?? [];

  // 算 dropdown 屏幕坐标 —— 用 portal 渲染到 body 避免被父级 overflow 裁掉
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPopPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as globalThis.Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const addToWorkspace = async (workspaceId: string) => {
    try {
      const ws = await api.getWorkspace(workspaceId);
      if (!ws) return;
      if (ws.nodes.some((n) => n.kind === 'card' && n.cardId === focusedCardId)) {
        // 已经在 workspace 里 → 直接打开 tab
        usePaneStoreImported.getState().openTab({
          kind: 'workspace',
          title: ws.name,
          workspaceId: ws.id,
        });
        setOpen(false);
        return;
      }
      const newNode = {
        kind: 'card' as const,
        id: crypto.randomUUID(),
        cardId: focusedCardId,
        x: 200 + Math.random() * 300,
        y: 200 + Math.random() * 200,
      };
      await api.updateWorkspace(workspaceId, { nodes: [...ws.nodes, newNode] });
      qc.invalidateQueries({ queryKey: ['workspace', workspaceId] });
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      usePaneStoreImported.getState().openTab({
        kind: 'workspace',
        title: ws.name,
        workspaceId: ws.id,
      });
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Add to workspace failed' });
    } finally {
      setOpen(false);
    }
  };

  const createAndAdd = async () => {
    const name = await dialog.prompt('New workspace name', {
      title: 'Create workspace',
      defaultValue: 'Workspace',
      confirmLabel: 'Create',
    });
    if (!name?.trim()) return;
    try {
      const ws = await api.createWorkspace(name.trim());
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      await addToWorkspace(ws.id);
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Create workspace failed' });
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'copy';
          e.dataTransfer.setData(
            'application/x-zettel-card',
            JSON.stringify({ luhmannId: focusedCardId, title: '' }),
          );
        }}
        onClick={() => setOpen((v) => !v)}
        className="shrink-0 text-[10px] font-bold flex items-center gap-1 px-2.5 py-1 rounded-full bg-accentSoft text-accent hover:bg-accent hover:text-white transition-colors cursor-pointer active:cursor-grabbing"
        title="Click to pick a workspace · Drag onto a workspace tab to add"
      >
        + Workspace
      </button>
      {open && popPos && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: popPos.top, right: popPos.right, zIndex: 1000 }}
          className="min-w-[220px] bg-white dark:bg-[#1e2030] border border-gray-200 dark:border-[#363a4f] rounded-md shadow-lg overflow-hidden"
        >
          <div className="px-3 py-2 text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100 dark:border-[#363a4f]">
            Add {focusedCardId} to…
          </div>
          <div className="max-h-60 overflow-y-auto">
            {list.length === 0 ? (
              <div className="text-[11px] text-gray-400 px-3 py-2">No workspaces yet</div>
            ) : (
              list.map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => addToWorkspace(ws.id)}
                  className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-accentSoft hover:text-accent"
                >
                  {ws.name}
                </button>
              ))
            )}
          </div>
          <button
            onClick={createAndAdd}
            className="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-bold border-t border-gray-100 dark:border-[#363a4f] text-accent hover:bg-accentSoft"
          >
            <span>+</span>
            <span>New workspace…</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

function ChevronLeftHistory() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
function ChevronRightHistory() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function FocusDepthBadge({ depth, max }: { depth: number; max: number }) {
  const atMax = depth >= max;
  // 渐变色：0 灰、1 蓝、2 黄、3 橙
  const color = depth === 0
    ? 'text-gray-400'
    : depth === 1
      ? 'text-sky-500'
      : depth === 2
        ? 'text-amber-500'
        : 'text-orange-600';
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-0.5">
        {Array.from({ length: max }, (_, i) => (
          <span
            key={i}
            className={`block w-1.5 h-1.5 rounded-full ${
              i < depth ? color.replace('text-', 'bg-') : 'bg-gray-200 dark:bg-[#494d64]'
            }`}
          />
        ))}
      </div>
      <span className={`text-[10px] font-bold uppercase tracking-widest ${color}`}>
        {atMax ? `Depth ${depth}/${max} · max` : `Depth ${depth}/${max}`}
      </span>
    </div>
  );
}

function EdgeToggle({
  color,
  label,
  active,
  onClick,
  title,
}: {
  color: string;
  label: string;
  active: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest transition-all ${
        active
          ? 'text-gray-700 hover:bg-gray-50'
          : 'text-gray-300 hover:text-gray-500 hover:bg-gray-50'
      }`}
    >
      <span
        className="w-2 h-2 rounded-full transition-all"
        style={{
          backgroundColor: active ? color : 'transparent',
          border: `1.5px solid ${active ? color : '#d1d5db'}`,
        }}
      />
      {label}
    </button>
  );
}

function FullCenter({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div className={`w-full h-full flex items-center justify-center text-sm ${error ? 'text-red-500' : 'text-gray-400'}`}>
      {children}
    </div>
  );
}

export function Canvas(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
