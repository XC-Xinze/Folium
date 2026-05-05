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
import { Download, ImagePlus, RotateCcw, Send } from 'lucide-react';
import { api, type Card, type PositionMap, type ResourceCard, type Workspace, type WorkspaceEdge, type WorkspaceNode } from '../lib/api';
import { dialog } from '../lib/dialog';
import { randomUUID } from '../lib/uuid';
import { CardNode } from './CardNode';
import { ResourceNode, type ResourceNodeData } from './ResourceNode';
import { CrossEdge, PotentialEdge, ResourceEdge } from './CanvasEdges';
import { applyAnchorPositions, buildGraph, computeBackbone, MASTER_BOX_ID, resolveCollisions, type CardNodeData } from '../lib/cardGraph';
import { DEFAULT_CARD_FLAGS, usePaneStore as usePaneStoreImported, type CardDisplayFlags } from '../store/paneStore';
import { exportReactFlowCanvasAsPng } from '../lib/exportCanvasImage';
import { useUIStore } from '../store/uiStore';
import { t } from '../lib/i18n';

const RESOURCE_NODE_PREFIX = 'resource:';
const resourceNodeId = (id: string) => `${RESOURCE_NODE_PREFIX}${id}`;
const nodeTypes = { card: CardNode, resource: ResourceNode };
const edgeTypes = { potential: PotentialEdge, cross: CrossEdge, resource: ResourceEdge };

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
  /** 每个 tab 自己持有 Potential 开关 —— 无值就回退到 DEFAULT_CARD_FLAGS */
  flags?: Partial<CardDisplayFlags>;
  /** 切换某一项时回写到 tab payload（PaneRoot 通过 updateTab 实现） */
  onFlagChange?: (key: keyof CardDisplayFlags, value: boolean) => void;
}

function CanvasInner({ focusedBoxId, focusedCardId, flags, onFlagChange }: Props) {
  const merged = { ...DEFAULT_CARD_FLAGS, ...(flags ?? {}) };
  const showPotential = merged.potential;
  // 没接 onFlagChange 的兜底：原地状态（用于 Canvas 被非 tab 场景用时不挂掉）
  const setFlag = (k: keyof CardDisplayFlags, v: boolean) => onFlagChange?.(k, v);
  const setShowPotential = (v: boolean) => setFlag('potential', v);
  const qc = useQueryClient();
  const language = useUIStore((s) => s.language);
  const flowRootRef = useRef<HTMLDivElement>(null);
  const resourceInputRef = useRef<HTMLInputElement>(null);

  const isMaster = focusedBoxId === MASTER_BOX_ID;

  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  // 拿 box 和 focus 的完整内容用于卡片正文渲染。
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

  const relatedIds = useMemo(() => {
    const set = new Set<string>();
    if (showPotential && focusedCardId) set.add(focusedCardId);
    return [...set];
  }, [focusedCardId, showPotential]);

  const relatedBatchQ = useQuery({
    queryKey: ['related-batch', relatedIds],
    queryFn: () => api.relatedBatch(relatedIds, 3),
    enabled: showPotential && relatedIds.length > 0,
  });

  // 工作区里涉及 backbone 卡片的边：作为 potential 风格的叠加显示在画布上
  const workspaceLinksQ = useQuery({
    queryKey: ['ws-links-batch', backboneIds],
    queryFn: () => api.workspaceLinksBatch(backboneIds),
    enabled: backboneIds.length > 0,
  });

  const resourcesQ = useQuery({
    queryKey: ['resources', focusedBoxId],
    queryFn: () => api.listResources(focusedBoxId),
    enabled: !isMaster,
  });
  const resourceRefsQ = useQuery({
    queryKey: ['resource-references'],
    queryFn: api.listResourceReferences,
    enabled: !isMaster,
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
      tagAnchorIds: [focusedBoxId],
      relatedBatch: relatedBatchQ.data ?? {},
      // Master 视图：只展示顶级卡的纯净网格，关掉所有关联层
      showPotential: isMaster ? false : showPotential,
      showTagRelated: false,
      showCrossLinks: !isMaster,
      showBoxCards: true,
      workspaceLinks: !isMaster ? workspaceLinksQ.data?.links ?? [] : [],
    });
    const resourceNodes = (resourcesQ.data?.resources ?? []).map<Node<ResourceNodeData>>((resource, index) => {
      const id = resourceNodeId(resource.id);
      const saved = positionsQ.data?.[id];
      return {
        id,
        type: 'resource',
        position: saved
          ? { x: saved.x, y: saved.y }
          : { x: 420 + (index % 3) * 300, y: 80 + Math.floor(index / 3) * 300 },
        data: {
          resource,
          onCardLinkDrop: async (sourceLuhmannId: string, resourceId: string) => {
            await api.appendResourceLink(sourceLuhmannId, resourceId);
            await Promise.all([
              qc.invalidateQueries({ queryKey: ['card', sourceLuhmannId] }),
              qc.invalidateQueries({ queryKey: ['cards'] }),
              qc.invalidateQueries({ queryKey: ['resource-references'] }),
            ]);
          },
          onDeleteOverride: async () => {
            const ok = await dialog.confirm(`Delete resource "${resource.title}"?`, {
              title: 'Delete resource',
              description: 'This removes the resource record and deletes the file from attachments/resources. Existing card references may become unresolved.',
              confirmLabel: 'Delete',
              variant: 'danger',
            });
            if (!ok) return;
            await api.deleteResource(resource.id);
            await Promise.all([
              qc.invalidateQueries({ queryKey: ['resources', focusedBoxId] }),
              qc.invalidateQueries({ queryKey: ['resources'] }),
              qc.invalidateQueries({ queryKey: ['resource-references'] }),
              qc.invalidateQueries({ queryKey: ['tags'] }),
            ]);
          },
        },
      };
    });
    const anchored = applyAnchorPositions(raw.nodes, raw.edges, positionsQ.data ?? {});
    // 一次性碰撞解算：把自动布局产生的重叠抹掉，但锁定用户手动拖过的位置
    const finalNodes = resolveCollisions(anchored, positionsQ.data ?? {});
    // 把 scope 印到每个节点 data 上，CardNode 直接读，多 pane 同屏不串
    const stamped = [...finalNodes, ...resourceNodes].map((n) => ({
      ...n,
      data: {
        ...(n.data as object),
        ...(n.type === 'card'
          ? {
              scope,
              superlinkSelection: {
                active: superlinkMode,
                selected: superlinkSelectedIds.has(((n.data as CardNodeData).card?.luhmannId) ?? String(n.id)),
                onToggle: toggleSuperlinkCard,
              },
            }
          : {}),
      },
    }));
    const visibleCardIds = new Set(finalNodes.map((node) => String(node.id)));
    const visibleResourceIds = new Set((resourcesQ.data?.resources ?? []).map((resource) => resource.id));
    const resourceEdges: Edge[] = (resourceRefsQ.data?.references ?? [])
      .filter((ref) => visibleCardIds.has(ref.cardId) && visibleResourceIds.has(ref.resourceId))
      .map((ref) => ({
        id: `resource:${ref.cardId}:${ref.resourceId}`,
        source: ref.cardId,
        target: resourceNodeId(ref.resourceId),
        type: 'resource',
        label: 'resource',
        data: { resourceId: ref.resourceId },
        style: {
          stroke: '#d6a21f',
          strokeWidth: 2,
          strokeDasharray: '5 3',
        },
        labelStyle: {
          fill: '#9a6a2f',
          fontWeight: 700,
          fontSize: 10,
        },
      }));
    return { nodes: stamped, edges: [...raw.edges, ...resourceEdges] };
  }, [
    scope,
    cardsQ.data,
    boxQ.data,
    fullCards,
    focusedBoxId,
    focusedCardId,
    isMaster,
    relatedBatchQ.data,
    showPotential,
    workspaceLinksQ.data,
    resourcesQ.data?.resources,
    resourceRefsQ.data?.references,
    positionsQ.data,
    superlinkMode,
    superlinkSelectedIds,
    toggleSuperlinkCard,
  ]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [layoutResetToken, setLayoutResetToken] = useState(0);

  const resetLayout = useCallback(async () => {
    const savedIds = Object.keys(positionsQ.data ?? {});
    if (savedIds.length === 0) return;
    stickyPosRef.current.clear();
    qc.setQueryData<PositionMap>(['positions', scope], {});
    setLayoutResetToken((n) => n + 1);
    await Promise.all(savedIds.map((id) => api.deletePosition(scope, id).catch(() => undefined)));
    await qc.invalidateQueries({ queryKey: ['positions', scope] });
  }, [positionsQ.data, qc, scope]);

  const exportImage = useCallback(async () => {
    try {
      await exportReactFlowCanvasAsPng({
        flowRoot: flowRootRef.current,
        nodes,
        fileName: `folium-box-${focusedBoxId}`,
      });
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Export image failed' });
    }
  }, [focusedBoxId, nodes]);

  const uploadResourceFile = useCallback(async (file: File) => {
    if (isMaster) return;
    const title = await dialog.prompt('Create a resource in this box?', {
      title: 'Resource',
      description: 'This does not create a Luhmann card. The file becomes an indexable resource inside the current box.',
      defaultValue: file.name.replace(/\.[^.]+$/, ''),
      confirmLabel: 'Create',
    });
    if (!title?.trim()) return;
    try {
      await api.uploadResource(file, { parentBoxId: focusedBoxId, title: title.trim() });
      await qc.invalidateQueries({ queryKey: ['resources', focusedBoxId] });
      await qc.invalidateQueries({ queryKey: ['resources'] });
      await qc.invalidateQueries({ queryKey: ['tags'] });
    } catch (err) {
      await dialog.alert((err as Error).message, { title: 'Create resource failed' });
    }
  }, [focusedBoxId, isMaster, qc]);

  const createResourcesFromFiles = useCallback(async (files: File[]) => {
    if (isMaster || files.length === 0) return;
    try {
      for (const file of files) {
        await api.uploadResource(file, {
          parentBoxId: focusedBoxId,
          title: file.name.replace(/\.[^.]+$/, ''),
        });
      }
      await qc.invalidateQueries({ queryKey: ['resources', focusedBoxId] });
      await qc.invalidateQueries({ queryKey: ['resources'] });
      await qc.invalidateQueries({ queryKey: ['tags'] });
    } catch (err) {
      await dialog.alert((err as Error).message, { title: 'Create resource failed' });
    }
  }, [focusedBoxId, isMaster, qc]);

  useEffect(() => {
    if (isMaster) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editingTarget = target?.closest('input, textarea, [contenteditable="true"]');
      if (editingTarget) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void createResourcesFromFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [createResourcesFromFiles, isMaster]);

  // 切换 box 时清缓存（避免跨 box 的位置串联）；同 box 内切换焦点时保留位置
  const prevBoxRef = useRef(focusedBoxId);
  const prevFocusRef = useRef(focusedCardId);
  const prevLayoutResetRef = useRef(layoutResetToken);
  // 会话级 sticky 位置缓存：节点已经摆好的位置不被 buildGraph 重排挪动
  const stickyPosRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  useEffect(() => {
    const boxChanged = prevBoxRef.current !== focusedBoxId;
    const focusChanged = prevFocusRef.current !== focusedCardId;
    const layoutReset = prevLayoutResetRef.current !== layoutResetToken;
    prevBoxRef.current = focusedBoxId;
    prevFocusRef.current = focusedCardId;
    prevLayoutResetRef.current = layoutResetToken;
    if (boxChanged || layoutReset) stickyPosRef.current.clear();

    setNodes((prev) => {
      if (boxChanged || layoutReset) {
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
      // potential 关联数据。这一段会把"prev 有但本次 graph 没有"
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
      if (boxChanged || layoutReset) return graph.edges;
      if (focusChanged && relatedBatchQ.isFetching) {
        const currentEdgeIds = new Set(graph.edges.map((e) => e.id));
        const carry = prev.filter((e) => !currentEdgeIds.has(e.id));
        return carry.length > 0 ? [...graph.edges, ...carry] : graph.edges;
      }
      return graph.edges;
    });
  }, [graph, focusedBoxId, focusedCardId, layoutResetToken, relatedBatchQ.isFetching, setNodes, setEdges]);

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
        title: 'Create workspace from picked cards',
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
          <EdgeToggle color="#cbd5e1" label={t('canvas.potential', {}, language)} active={showPotential} onClick={() => setShowPotential(!showPotential)} title="Text-similarity potential edges (gray dashed)" />
        </div>
        <span className="w-px h-4 bg-paperEdge/80 dark:bg-[#494d64]" />
        <button
          onClick={() => void resetLayout()}
          className="shrink-0 text-[10px] font-bold flex items-center gap-1 px-2.5 py-1 rounded-full border zk-subtle-button transition-colors"
          title={t('canvas.resetLayout', {}, language)}
        >
          <RotateCcw size={12} strokeWidth={2.4} />
          <span>{t('canvas.resetLayout', {}, language)}</span>
        </button>
        {!isMaster && (
          <>
            <input
              ref={resourceInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (file) void uploadResourceFile(file);
              }}
            />
            <button
              onClick={() => resourceInputRef.current?.click()}
              className="shrink-0 text-[10px] font-bold flex items-center gap-1 px-2.5 py-1 rounded-full border zk-subtle-button transition-colors"
              title={t('canvas.resource', {}, language)}
            >
              <ImagePlus size={12} strokeWidth={2.4} />
              <span>{t('canvas.resource', {}, language)}</span>
            </button>
          </>
        )}
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
              <span>{t('canvas.createWorkspace', {}, language)}</span>
            </button>
            <button
              onClick={() => setSuperlinkWorkspacePickerOpen(true)}
              className="text-[10px] font-bold px-2.5 py-1 rounded-full border zk-subtle-button hover:bg-accentSoft transition-colors"
              title="Add picked cards to an existing workspace"
            >
              {t('canvas.addToWorkspace', {}, language)}
            </button>
            <button
              onClick={cancelSuperlinkMode}
              className="text-[10px] font-bold px-2.5 py-1 rounded-full border zk-subtle-button transition-colors"
              title="Exit pick mode"
            >
              {t('canvas.cancelPick', {}, language)}
            </button>
          </div>
        ) : (
          <button
            onClick={startSuperlinkMode}
            className="shrink-0 text-[10px] font-bold flex items-center gap-1 px-2.5 py-1 rounded-full border zk-subtle-button transition-colors"
            title={t('canvas.pickCards', {}, language)}
          >
            <Send size={12} strokeWidth={2.4} />
            <span>{t('canvas.pickCards', {}, language)}</span>
          </button>
        )}
        <AddFocusedToWorkspace focusedCardId={focusedCardId} />
      </div>

      <div ref={flowRootRef} className="flex-1 relative min-h-0 zk-canvas-bg">
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
        <button
          type="button"
          className="absolute bottom-[116px] right-4 z-20 flex h-[31px] w-[31px] items-center justify-center rounded-full border border-paperEdge bg-paper/85 text-muted shadow-paper backdrop-blur transition-colors hover:bg-accentSoft hover:text-ink hover:border-accent/35"
          title={t('canvas.exportImage', {}, language)}
          aria-label="Export canvas as PNG"
          onClick={() => void exportImage()}
        >
          <Download size={13} strokeWidth={2.4} />
        </button>
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
  const language = useUIStore((s) => s.language);
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
        {t('canvas.workspaceButton', {}, language)}
      </button>
      {open && popPos && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: popPos.top, right: popPos.right, zIndex: 1000 }}
          className="min-w-[220px] bg-white dark:bg-[#1e2030] border border-gray-200 dark:border-[#363a4f] rounded-md shadow-lg overflow-hidden"
        >
          <div className="px-3 py-2 text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100 dark:border-[#363a4f]">
            {t('canvas.addFocusedTo', { id: focusedCardId }, language)}
          </div>
          <div className="max-h-60 overflow-y-auto">
            {list.length === 0 ? (
              <div className="text-[11px] text-gray-400 px-3 py-2">{t('canvas.noWorkspaces', {}, language)}</div>
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
            <span>{t('canvas.newWorkspace', {}, language)}</span>
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
          ? 'text-ink border-accent/40 bg-accentSoft hover:border-accent/60'
          : 'text-gray-400 dark:text-[#a5adcb] border-transparent hover:text-gray-500 dark:hover:text-[#cad3f5] hover:bg-surfaceAlt'
      }`}
    >
      <span
        className="w-2 h-2 rounded-full transition-all"
        style={{
          backgroundColor: active ? color : 'transparent',
          border: `1.5px solid ${active ? color : 'var(--zk-paper-edge)'}`,
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
