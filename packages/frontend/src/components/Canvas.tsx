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
import { Send } from 'lucide-react';
import { api, type Card, type PositionMap, type Workspace, type WorkspaceEdge, type WorkspaceNode } from '../lib/api';
import { dialog } from '../lib/dialog';
import { randomUUID } from '../lib/uuid';
import { CardNode } from './CardNode';
import { CrossEdge, PotentialEdge } from './CanvasEdges';
import { applyAnchorPositions, buildGraph, computeBackbone, MASTER_BOX_ID, resolveCollisions, type CardNodeData } from '../lib/cardGraph';
import { MAX_EXPLORATION_DEPTH, nextExplorationTrail } from '../lib/explorationTrail';
import { DEFAULT_CARD_FLAGS, usePaneStore as usePaneStoreImported, type CardDisplayFlags } from '../store/paneStore';

const nodeTypes = { card: CardNode };
const edgeTypes = { potential: PotentialEdge, cross: CrossEdge };

interface SuperlinkEdgeOption {
  sourceCardId: string;
  targetCardId: string;
  label?: string;
  vaultLink?: boolean;
  vaultStructure?: boolean;
}

function graphEdgeLabel(edgeId: string): string | undefined {
  if (edgeId.startsWith('tree:')) return 'tree';
  if (edgeId.startsWith('cross:')) return 'link';
  if (edgeId.startsWith('tag:')) return 'tag';
  if (edgeId.startsWith('pot:')) return 'potential';
  if (edgeId.startsWith('ws:')) return 'workspace';
  return undefined;
}

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

const MAX_FOCUS_DEPTH = MAX_EXPLORATION_DEPTH;

function CanvasInner({ focusedBoxId, focusedCardId, flags, onFlagChange, focusDepth = 0 }: Props) {
  const merged = { ...DEFAULT_CARD_FLAGS, ...(flags ?? {}) };
  const showPotential = merged.potential;
  const showTagRelated = merged.tag;
  const showCrossLinks = merged.cross;
  const showBoxCards = merged.box;
  const showWorkspaceLinks = merged.workspaceLinks;
  // 没接 onFlagChange 的兜底：原地状态（用于 Canvas 被非 tab 场景用时不挂掉）
  const setFlag = (k: keyof CardDisplayFlags, v: boolean) => onFlagChange?.(k, v);
  const setShowPotential = (v: boolean) => setFlag('potential', v);
  const setShowTagRelated = (v: boolean) => setFlag('tag', v);
  const setShowCrossLinks = (v: boolean) => setFlag('cross', v);
  const setShowBoxCards = (v: boolean) => setFlag('box', v);
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

  // Exploration trail：记录用户连续点过的关系锚点，而不是无限累加所有曾经拉进来的邻居。
  // Box toggle 负责是否铺开当前盒子的结构卡；trail 负责在 link-only/tag-only 探索时保留路径上下文。
  const [tagTrailIds, setTagTrailIds] = useState<string[]>(() => [focusedBoxId]);
  const prevTrailFocusRef = useRef(focusedCardId);
  // box 切了 → 重置 trail
  useEffect(() => {
    setTagTrailIds([focusedBoxId]);
    prevTrailFocusRef.current = focusedBoxId;
  }, [focusedBoxId]);
  // 焦点切换：沿 tree/link 走就保留路径；跳到无关卡时收束到新的上下文。
  useEffect(() => {
    const focusCard = cardsQ.data?.cards.find((c) => c.luhmannId === focusedCardId);
    const prevFocus = prevTrailFocusRef.current;
    prevTrailFocusRef.current = focusedCardId;
    if (!focusCard) setTagTrailIds([focusedBoxId]);
    else {
      setTagTrailIds((prev) =>
        nextExplorationTrail({
          prevTrail: prev,
          focusedBoxId,
          previousFocusId: prevFocus,
          nextFocusId: focusedCardId,
          focusDepth,
          cards: cardsQ.data?.cards ?? [],
        }),
      );
    }
  }, [focusedBoxId, focusedCardId, focusDepth, cardsQ.data]);

  // 焦点卡若是从外部 tag-related 拉进来的（不在 backbone 里），单独把它加进 relatedBatch
  // 否则它的 tagRelated 拿不到 → buildGraph 退化成"所有 backbone 卡两两连"
  // 同时把 tag trail 全部锚也加进来，保证 buildGraph 能拿到每个锚的 batch 数据
  const relatedIds = useMemo(() => {
    const set = new Set<string>();
    if (focusedCardId) set.add(focusedCardId);
    for (const id of tagTrailIds) set.add(id);
    if (showBoxCards) {
      for (const id of backboneIds) set.add(id);
    }
    return [...set];
  }, [backboneIds, focusedCardId, tagTrailIds, showBoxCards]);

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

  const [superlinkMode, setSuperlinkMode] = useState(false);
  const [superlinkSelectedIds, setSuperlinkSelectedIds] = useState<Set<string>>(() => new Set());
  const [superlinkWorkspacePickerOpen, setSuperlinkWorkspacePickerOpen] = useState(false);
  const toggleSuperlinkCard = useCallback((cardId: string) => {
    setSuperlinkSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

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
      showBoxCards: isMaster ? true : showBoxCards,
      workspaceLinks: showWorkspaceLinks && !isMaster ? workspaceLinksQ.data?.links ?? [] : [],
    });
    const anchored = applyAnchorPositions(raw.nodes, raw.edges, positionsQ.data ?? {});
    // 一次性碰撞解算：把自动布局产生的重叠抹掉，但锁定用户手动拖过的位置
    const finalNodes = resolveCollisions(anchored, positionsQ.data ?? {});
    // 把 scope 印到每个节点 data 上，CardNode 直接读，多 pane 同屏不串
    const stamped = finalNodes.map((n) => ({
      ...n,
      data: {
        ...(n.data as object),
        scope,
        superlinkSelection: {
          active: superlinkMode,
          selected: superlinkSelectedIds.has(((n.data as CardNodeData).card?.luhmannId) ?? String(n.id)),
          onToggle: toggleSuperlinkCard,
        },
      },
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
    showBoxCards,
    showWorkspaceLinks,
    workspaceLinksQ.data,
    positionsQ.data,
    superlinkMode,
    superlinkSelectedIds,
    toggleSuperlinkCard,
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

  const collectSelectedSuperlinkEdges = useCallback((selectedIds: Set<string>): SuperlinkEdgeOption[] => {
    const graphIdToCardId = new Map<string, string>();
    for (const node of nodes) {
      if (String(node.id).startsWith('__')) continue;
      const data = node.data as Partial<CardNodeData> | undefined;
      const cardId = data?.card?.luhmannId ?? String(node.id);
      if (cardId && selectedIds.has(cardId)) graphIdToCardId.set(String(node.id), cardId);
    }
    const seenEdges = new Set<string>();
    const selectedEdges: SuperlinkEdgeOption[] = [];
    for (const edge of edges) {
      const sourceCardId = graphIdToCardId.get(String(edge.source)) ?? String(edge.source);
      const targetCardId = graphIdToCardId.get(String(edge.target)) ?? String(edge.target);
      if (!selectedIds.has(sourceCardId) || !selectedIds.has(targetCardId) || sourceCardId === targetCardId) continue;
      const label = graphEdgeLabel(String(edge.id));
      const key = `${sourceCardId}->${targetCardId}:${label ?? ''}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      selectedEdges.push({
        sourceCardId,
        targetCardId,
        label,
        vaultLink: label === 'link',
        vaultStructure: label === 'tree',
      });
    }
    return selectedEdges;
  }, [edges, nodes]);

  const collectPickedSuperlinkCards = useCallback((selectedIds: Set<string>) => {
    return nodes
      .map((node) => {
        if (String(node.id).startsWith('__')) return null;
        const data = node.data as Partial<CardNodeData> | undefined;
        const cardId = data?.card?.luhmannId ?? String(node.id);
        if (!cardId || !selectedIds.has(cardId)) return null;
        return {
          cardId,
          x: node.position.x,
          y: node.position.y,
        };
      })
      .filter((node): node is { cardId: string; x: number; y: number } => node !== null);
  }, [nodes]);

  const buildSuperlinkWorkspaceData = useCallback(
    (picked: Array<{ cardId: string; x: number; y: number }>, base?: Workspace) => {
      const minX = Math.min(...picked.map((card) => card.x));
      const minY = Math.min(...picked.map((card) => card.y));
      const selectedIds = new Set(picked.map((card) => card.cardId));
      const workspaceIdByCardId = new Map<string, string>();
      const existingNodes = base?.nodes ?? [];
      const existingEdges = base?.edges ?? [];
      const nextNodes: WorkspaceNode[] = [...existingNodes];

      for (const node of existingNodes) {
        if (node.kind === 'card') workspaceIdByCardId.set(node.cardId, node.id);
      }

      for (const card of picked) {
        if (workspaceIdByCardId.has(card.cardId)) continue;
        const id = randomUUID();
        workspaceIdByCardId.set(card.cardId, id);
        nextNodes.push({
          kind: 'card',
          id,
          cardId: card.cardId,
          x: Math.round(card.x - minX + 160),
          y: Math.round(card.y - minY + 140),
        });
      }

      const nextEdges: WorkspaceEdge[] = existingEdges.map((edge) =>
        edge.label === 'tree' ? { ...edge, vaultStructure: true } : edge,
      );
      const hasEdge = (source: string, target: string, label?: string) =>
        nextEdges.some((edge) => edge.source === source && edge.target === target && (edge.label ?? '') === (label ?? ''));

      for (const edge of collectSelectedSuperlinkEdges(selectedIds)) {
        const source = workspaceIdByCardId.get(edge.sourceCardId);
        const target = workspaceIdByCardId.get(edge.targetCardId);
        if (!source || !target || hasEdge(source, target, edge.label)) continue;
        nextEdges.push({
          id: randomUUID(),
          source,
          target,
          label: edge.label,
          applied: false,
          vaultLink: edge.vaultLink,
          vaultStructure: edge.vaultStructure,
        });
      }

      return { nodes: nextNodes, edges: nextEdges };
    },
    [collectSelectedSuperlinkEdges],
  );

  const startSuperlinkMode = useCallback(async () => {
    const hasSelectableCards = nodes.some((node) => {
      if (String(node.id).startsWith('__')) return false;
      const data = node.data as Partial<CardNodeData> | undefined;
      const cardId = data?.card?.luhmannId ?? String(node.id);
      return !!cardId && !String(cardId).startsWith('__');
    });
    if (!hasSelectableCards) {
      await dialog.alert('No visible cards can be picked.', { title: 'Superlink' });
      return;
    }
    setSuperlinkSelectedIds(new Set([focusedCardId]));
    setSuperlinkMode(true);
  }, [focusedCardId, nodes]);

  const cancelSuperlinkMode = useCallback(() => {
    setSuperlinkMode(false);
    setSuperlinkSelectedIds(new Set());
  }, []);

  const createSuperlinkWorkspace = useCallback(async () => {
    const selectedIds = superlinkSelectedIds;
    const picked = collectPickedSuperlinkCards(selectedIds);

    if (picked.length === 0) {
      await dialog.alert('Pick at least one card on the canvas.', { title: 'Superlink' });
      return;
    }

    const name = await dialog.prompt(
      `Create a workspace from ${picked.length} picked card${picked.length === 1 ? '' : 's'}?`,
      {
        title: 'Create picked chain',
        description: 'Only selected cards are copied. Cards are not moved and vault files are not changed.',
        defaultValue: `Superlink · ${focusedCardId}`,
        confirmLabel: 'Create',
      },
    );
    if (!name?.trim()) return;

    const { nodes: workspaceNodes, edges: workspaceEdges } = buildSuperlinkWorkspaceData(picked);

    try {
      const created = await api.createWorkspace(name.trim());
      const workspace = await api.updateWorkspace(created.id, {
        nodes: workspaceNodes,
        edges: workspaceEdges,
      });
      qc.setQueryData(['workspace', workspace.id], workspace);
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      usePaneStoreImported.getState().openTab({
        kind: 'workspace',
        title: workspace.name,
        workspaceId: workspace.id,
      });
      cancelSuperlinkMode();
    } catch (err) {
      await dialog.alert((err as Error).message, { title: 'Create superlink workspace failed' });
    }
  }, [buildSuperlinkWorkspaceData, cancelSuperlinkMode, collectPickedSuperlinkCards, focusedCardId, qc, superlinkSelectedIds]);

  const addSuperlinkToWorkspace = useCallback(async (workspaceIdToUpdate: string) => {
    const selectedIds = superlinkSelectedIds;
    const picked = collectPickedSuperlinkCards(selectedIds);
    if (picked.length === 0) {
      await dialog.alert('Pick at least one card on the canvas.', { title: 'Superlink' });
      return;
    }
    try {
      const existing = await api.getWorkspace(workspaceIdToUpdate);
      const patch = buildSuperlinkWorkspaceData(picked, existing);
      const workspace = await api.updateWorkspace(workspaceIdToUpdate, patch);
      qc.setQueryData(['workspace', workspace.id], workspace);
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      qc.invalidateQueries({ queryKey: ['ws-links-batch'] });
      usePaneStoreImported.getState().openTab({
        kind: 'workspace',
        title: workspace.name,
        workspaceId: workspace.id,
      });
      setSuperlinkWorkspacePickerOpen(false);
      cancelSuperlinkMode();
    } catch (err) {
      await dialog.alert((err as Error).message, { title: 'Add to workspace failed' });
    }
  }, [buildSuperlinkWorkspaceData, cancelSuperlinkMode, collectPickedSuperlinkCards, qc, superlinkSelectedIds]);

  const selectedSuperlinkEdgeCount = useMemo(
    () => collectSelectedSuperlinkEdges(superlinkSelectedIds).length,
    [collectSelectedSuperlinkEdges, superlinkSelectedIds],
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
      {/* Canvas 顶部工具栏 —— inline，但使用和 Graph/Workspace 一致的纸感表面。 */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 zk-toolbar-surface border-b overflow-x-auto">
        <HistoryButtons />
        <span className="w-px h-4 bg-paperEdge/80 dark:bg-[#494d64]" />
        <div className="flex items-center gap-1.5">
          <EdgeToggle color="#385f73" label="Link" active={showCrossLinks} onClick={() => setShowCrossLinks(!showCrossLinks)} title="Manual [[link]] edges" />
          <EdgeToggle color="#536253" label="Tag" active={showTagRelated} onClick={() => setShowTagRelated(!showTagRelated)} title="Tag co-occurrence edges" />
          <EdgeToggle color="#ba635c" label="Box" active={showBoxCards} onClick={() => setShowBoxCards(!showBoxCards)} title="Cards inside the current index / box" />
          <EdgeToggle color="#cbd5e1" label="Potential" active={showPotential} onClick={() => setShowPotential(!showPotential)} title="Text-similarity potential edges (gray dashed)" />
          <EdgeToggle color="#536253" label="Temp" active={showWorkspaceLinks} onClick={() => setShowWorkspaceLinks(!showWorkspaceLinks)} title="Workspace temp ghost cards and their links" />
        </div>
        <span className="w-px h-4 bg-paperEdge/80 dark:bg-[#494d64]" />
        <FocusDepthBadge depth={focusDepth} max={MAX_FOCUS_DEPTH} />
        <div className="flex-1" />
        {superlinkMode ? (
          <div className="shrink-0 flex items-center gap-1.5">
            <span className="text-[10px] font-bold text-accent">
              {superlinkSelectedIds.size} cards · {selectedSuperlinkEdgeCount} links
            </span>
            <button
              onClick={createSuperlinkWorkspace}
              className="text-[10px] font-bold flex items-center gap-1 px-2.5 py-1 rounded-full bg-accent text-white hover:bg-accent/90 transition-colors shadow-sm"
              title="Create a workspace from picked cards"
            >
              <Send size={12} strokeWidth={2.4} />
              <span>Create Workspace</span>
            </button>
            <button
              onClick={() => setSuperlinkWorkspacePickerOpen(true)}
              className="text-[10px] font-bold px-2.5 py-1 rounded-full border zk-subtle-button hover:bg-accentSoft transition-colors"
              title="Add picked cards to an existing workspace"
            >
              Add to Workspace
            </button>
            <button
              onClick={cancelSuperlinkMode}
              className="text-[10px] font-bold px-2.5 py-1 rounded-full border zk-subtle-button transition-colors"
              title="Exit pick mode"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={startSuperlinkMode}
            className="shrink-0 text-[10px] font-bold flex items-center gap-1 px-2.5 py-1 rounded-full border zk-subtle-button transition-colors"
            title="Pick cards on the canvas and copy them into a new workspace"
          >
            <Send size={12} strokeWidth={2.4} />
            <span>Pick Chain</span>
          </button>
        )}
        <AddFocusedToWorkspace focusedCardId={focusedCardId} />
      </div>

      <div className="flex-1 relative min-h-0 zk-canvas-bg">
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
          <Background id={`vault-bg-${focusedBoxId}`} gap={24} size={1.2} color="rgba(116,120,120,0.20)" />
          <Controls position="bottom-right" showInteractive={false} />
          <MiniMap pannable zoomable position="top-right" maskColor="rgba(83,98,83,0.07)" />
        </ReactFlow>
      </div>
      {superlinkWorkspacePickerOpen && (
        <SuperlinkWorkspacePicker
          onClose={() => setSuperlinkWorkspacePickerOpen(false)}
          onPick={addSuperlinkToWorkspace}
        />
      )}
    </div>
  );
}

function SuperlinkWorkspacePicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (workspaceId: string) => void;
}) {
  const wsQ = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces });
  const list = wsQ.data?.workspaces ?? [];
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/30 backdrop-blur-[2px]">
      <div className="w-[360px] max-w-[92vw] bg-white dark:bg-[#1e2030] border border-gray-200 dark:border-[#363a4f] rounded-lg shadow-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-[#363a4f]">
          <div className="text-sm font-bold text-ink dark:text-[#cad3f5]">Add picked cards to workspace</div>
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {wsQ.isLoading && <div className="px-4 py-3 text-xs text-gray-400">Loading…</div>}
          {!wsQ.isLoading && list.length === 0 && (
            <div className="px-4 py-3 text-xs text-gray-400">No workspaces yet</div>
          )}
          {list.map((ws) => (
            <button
              key={ws.id}
              onClick={() => onPick(ws.id)}
              className="w-full flex items-center justify-between px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-[#363a4f]"
            >
              <span className="text-sm font-semibold truncate">{ws.name}</span>
              <span className="text-[10px] text-gray-400 ml-3 shrink-0">{ws.nodes.length} nodes</span>
            </button>
          ))}
        </div>
        <div className="px-4 py-3 flex justify-end border-t border-gray-100 dark:border-[#363a4f]">
          <button
            onClick={onClose}
            className="text-xs font-bold px-3 py-1.5 rounded text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
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
  const returnTab = tab.returnToTabId ? leaf.tabs.find((t) => t.id === tab.returnToTabId) : null;
  const canBack = idx > 0 || !!returnTab;
  const canFwd = idx >= 0 && idx < hist.length - 1;
  const back = () => {
    if (idx > 0) {
      usePaneStoreImported.getState().goBackInTab(leaf.id, leaf.activeTabId!);
      return;
    }
    if (returnTab) usePaneStoreImported.getState().setActiveTab(leaf.id, returnTab.id);
  };
  const forward = () =>
    usePaneStoreImported.getState().goForwardInTab(leaf.id, leaf.activeTabId!);
  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={back}
        disabled={!canBack}
        className="p-0.5 rounded zk-subtle-button disabled:opacity-25 border border-transparent"
        title="Back (⌘[)"
      >
        <ChevronLeftHistory />
      </button>
      <button
        onClick={forward}
        disabled={!canFwd}
        className="p-0.5 rounded zk-subtle-button disabled:opacity-25 border border-transparent"
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
        className="shrink-0 text-[10px] font-bold flex items-center gap-1 px-2.5 py-1 rounded-full border zk-subtle-button hover:text-accent transition-colors cursor-pointer active:cursor-grabbing"
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
  const color = depth === 0 ? 'text-gray-400' : atMax ? 'text-[#ba635c]' : 'text-accent';
  const dotColor = depth === 0 ? 'bg-paperEdge dark:bg-[#494d64]' : atMax ? 'bg-[#ba635c]' : 'bg-accent';
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-0.5">
        {Array.from({ length: max }, (_, i) => (
          <span
            key={i}
            className={`block w-1.5 h-1.5 rounded-full ${
              i < depth ? dotColor : 'bg-paperEdge/80 dark:bg-[#494d64]'
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
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-widest transition-all ${
        active
          ? 'text-gray-700 dark:text-[#cad3f5] border-paperEdge bg-paper/70 hover:border-accent/40'
          : 'text-gray-300 dark:text-gray-600 border-transparent hover:text-gray-500 hover:bg-paper/40'
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
