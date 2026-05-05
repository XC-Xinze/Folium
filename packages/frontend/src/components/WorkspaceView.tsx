import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type OnConnect,
  type EdgeProps,
  EdgeLabelRenderer,
  BaseEdge,
  getBezierPath,
  Position,
} from '@xyflow/react';
import { isCardDrag, isResourceDrag, readCardDragData, readResourceDragData } from '../lib/dragCard';
import { RenamableName } from './RenamableName';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  Download,
  FilePlus,
  Layers,
  Link2,
  PackageOpen,
  StickyNote,
  Undo2,
  X,
} from 'lucide-react';
import { randomUUID } from '../lib/uuid';
import { api, type Workspace, type WorkspaceEdge, type WorkspaceNode } from '../lib/api';
import { dialog } from '../lib/dialog';
import { CardNode } from './CardNode';
import { WorkspaceNoteNode } from './WorkspaceNoteNode';
import { WorkspaceTempNode } from './WorkspaceTempNode';
import { ResourceNode } from './ResourceNode';
import { useUIStore, type WorkspaceRelationFilter } from '../store/uiStore';
import { exportReactFlowCanvasAsPng } from '../lib/exportCanvasImage';
import { t, type LanguagePreference } from '../lib/i18n';

interface Props {
  workspaceId: string;
}

type RelationFilter = WorkspaceRelationFilter;

const RELATION_FILTER_OPTIONS: Array<{
  id: RelationFilter;
  label: string;
  description: string;
}> = [
  { id: 'all', label: 'All relations', description: 'Show every visible workspace edge.' },
  { id: 'draft', label: 'Draft card links', description: 'Real card pairs that are not written to the vault yet.' },
  { id: 'vault', label: 'Vault links', description: 'Relations already represented by vault links or structure.' },
  { id: 'temp', label: 'Temp links', description: 'Relations touching a workspace temp card.' },
  { id: 'workspace', label: 'Workspace only', description: 'Relations between notes or other local workspace items.' },
];

function relationLabel(id: RelationFilter, language: LanguagePreference): string {
  return t(`workspace.filter.${id}` as Parameters<typeof t>[0], {}, language);
}

function relationShortLabel(id: RelationFilter, language: LanguagePreference): string {
  return t(`workspace.filter.${id}Short` as Parameters<typeof t>[0], {}, language);
}

function relationDescription(id: RelationFilter, language: LanguagePreference): string {
  return t(`workspace.filter.${id}Desc` as Parameters<typeof t>[0], {}, language);
}

function sameWorkspacePair(a: Pick<WorkspaceEdge, 'source' | 'target'>, b: Pick<WorkspaceEdge, 'source' | 'target'>): boolean {
  return (a.source === b.source && a.target === b.target) || (a.source === b.target && a.target === b.source);
}

function hasWorkspacePair(edges: WorkspaceEdge[], source: string, target: string): boolean {
  return edges.some((edge) => sameWorkspacePair(edge, { source, target }));
}

function dedupeWorkspaceEdges(edges: WorkspaceEdge[]): WorkspaceEdge[] {
  const seen = new Set<string>();
  const out: WorkspaceEdge[] = [];
  for (const edge of edges) {
    const key = [edge.source, edge.target].sort().join('::');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

function workspaceRelationKind(
  edge: WorkspaceEdge,
  nodeKinds: Map<string, WorkspaceNode['kind']>,
): Exclude<RelationFilter, 'all'> {
  const sourceKind = nodeKinds.get(edge.source) ?? 'card';
  const targetKind = nodeKinds.get(edge.target) ?? 'card';
  const bothCards = sourceKind === 'card' && targetKind === 'card';
  if (edge.applied || edge.vaultLink || edge.vaultStructure || edge.label === 'tree') return 'vault';
  if (sourceKind === 'temp' || targetKind === 'temp') return 'temp';
  if (bothCards) return 'draft';
  return 'workspace';
}

function edgeMatchesRelationFilter(edge: Edge, filter: RelationFilter): boolean {
  if (filter === 'all') return true;
  const data = edge.data as
    | {
        applied?: boolean;
        vaultLink?: boolean;
        vaultStructure?: boolean;
        bothCards?: boolean;
        sourceKind?: WorkspaceNode['kind'];
        targetKind?: WorkspaceNode['kind'];
      }
    | undefined;
  if (!data) return true;
  const isVault = !!data.applied || !!data.vaultLink || !!data.vaultStructure;
  const hasTemp = data.sourceKind === 'temp' || data.targetKind === 'temp';
  const bothCards = data.bothCards || (data.sourceKind === 'card' && data.targetKind === 'card');
  if (filter === 'vault') return isVault;
  if (filter === 'temp') return !isVault && hasTemp;
  if (filter === 'draft') return !isVault && !hasTemp && bothCards;
  return !isVault && !hasTemp && !bothCards;
}

function controlOffset(distance: number, curvature = 0.25): number {
  return distance >= 0 ? 0.5 * distance : curvature * 25 * Math.sqrt(-distance);
}

function bezierControlPoint({
  position,
  x1,
  y1,
  x2,
  y2,
}: {
  position: Position;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}): { x: number; y: number } {
  switch (position) {
    case Position.Left:
      return { x: x1 - controlOffset(x1 - x2), y: y1 };
    case Position.Right:
      return { x: x1 + controlOffset(x2 - x1), y: y1 };
    case Position.Top:
      return { x: x1, y: y1 - controlOffset(y1 - y2) };
    case Position.Bottom:
    default:
      return { x: x1, y: y1 + controlOffset(y2 - y1) };
  }
}

function cubicBezierPoint(
  t: number,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): { x: number; y: number } {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

export function WorkspaceView(props: Props) {
  return (
    <ReactFlowProvider>
      <WorkspaceInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkspaceInner({ workspaceId }: Props) {
  // 之前 workspace 在面板里时用 uiStore 管 fullscreen/dock/pin —— pane 系统取代了这些
  const qc = useQueryClient();
  const wsQ = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => api.getWorkspace(workspaceId),
  });
  const resourcesQ = useQuery({ queryKey: ['resources'], queryFn: () => api.listResources() });
  const resourceMap = useMemo(
    () => new Map((resourcesQ.data?.resources ?? []).map((resource) => [resource.id, resource] as const)),
    [resourcesQ.data?.resources],
  );
  const savedRelationFilter = useUIStore((s) => s.workspaceRelationFilters[workspaceId] ?? 'all');
  const setSavedRelationFilter = useUIStore((s) => s.setWorkspaceRelationFilter);
  const language = useUIStore((s) => s.language);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [relationFilter, setRelationFilter] = useState<RelationFilter>(savedRelationFilter);
  const [relationMenuOpen, setRelationMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const resourceInputRef = useRef<HTMLInputElement>(null);
  const reactFlow = useReactFlow();
  useEffect(() => {
    setRelationFilter(savedRelationFilter);
  }, [savedRelationFilter, workspaceId]);
  const chooseRelationFilter = useCallback(
    (filter: RelationFilter) => {
      setRelationFilter(filter);
      setSavedRelationFilter(workspaceId, filter);
    },
    [setSavedRelationFilter, workspaceId],
  );

  // 把后端 workspace data 转成 React Flow 的 nodes/edges
  const buildNodes = useCallback(
    (
      ws: Workspace,
      handlers: {
        updateNode: (id: string, patch: Partial<WorkspaceNode>) => void;
        deleteNode: (id: string) => void;
        promoteTempToVault: (id: string) => void;
        addEdgeBetween: (sourceWsNodeId: string, targetWsNodeId: string) => void;
      },
    ): { nodes: Node[]; edges: Edge[] } => {
      const wsNodes: Node[] = ws.nodes.map((n) => {
        if (n.kind === 'card') {
          return {
            id: n.id,
            type: 'card',
            position: { x: n.x, y: n.y },
            width: n.w,
            height: n.h,
            data: {
              card: { luhmannId: n.cardId, title: '', status: 'ATOMIC', tags: [], crossLinks: [], depth: 0, sortKey: '' },
              variant: 'tree',
              isInWorkspace: true,
              savedW: n.w,
              savedH: n.h,
              onDeleteOverride: () => handlers.deleteNode(n.id),
              onResizeOverride: (w: number, h: number) => handlers.updateNode(n.id, { w, h } as Partial<WorkspaceNode>),
              onWorkspaceNodeLinkDrop: (sourceNodeId: string) => {
                if (sourceNodeId === n.id) return;
                handlers.addEdgeBetween(sourceNodeId, n.id);
              },
              // 拖卡到本卡 → 创建 workspace edge（不写 vault）
              // dragged 是 luhmann id，需要查找 ws 里对应的 node id
              onCardLinkDrop: (sourceLuhmannId: string) => {
                const sourceNode = ws.nodes.find(
                  (m) => m.kind === 'card' && (m as { cardId?: string }).cardId === sourceLuhmannId,
                );
                if (!sourceNode) return; // source 不在本 workspace
                if (sourceNode.id === n.id) return;
                handlers.addEdgeBetween(sourceNode.id, n.id);
              },
            } as unknown as Record<string, unknown>,
          };
        }
        if (n.kind === 'resource') {
          return {
            id: n.id,
            type: 'resource',
            position: { x: n.x, y: n.y },
            width: n.w,
            height: n.h,
            data: {
              resource: resourceMap.get(n.resourceId) ?? {
                id: n.resourceId,
                kind: 'file',
                title: n.resourceId,
                path: '',
                tags: [],
                parentBoxId: null,
                note: '',
                createdAt: '',
                updatedAt: '',
              },
              workspaceNodeId: n.id,
              onDeleteOverride: () => handlers.deleteNode(n.id),
              onWorkspaceNodeLinkDrop: (sourceNodeId: string) => {
                if (sourceNodeId === n.id) return;
                handlers.addEdgeBetween(sourceNodeId, n.id);
              },
            } as unknown as Record<string, unknown>,
          };
        }
        if (n.kind === 'note') {
          return {
            id: n.id,
            type: 'wsNote',
            position: { x: n.x, y: n.y },
            width: n.w,
            height: n.h,
            data: {
              content: n.content,
              onChange: (content: string) => handlers.updateNode(n.id, { content }),
              onDelete: () => handlers.deleteNode(n.id),
              savedW: n.w,
              savedH: n.h,
              onResize: (w: number, h: number) => handlers.updateNode(n.id, { w, h } as Partial<WorkspaceNode>),
            } as unknown as Record<string, unknown>,
          };
        }
        // temp
        return {
          id: n.id,
          type: 'wsTemp',
          position: { x: n.x, y: n.y },
          width: n.w,
          height: n.h,
          data: {
            title: n.title,
            content: n.content,
            workspaceNodeId: n.id,
            onChange: (patch: { title?: string; content?: string }) => handlers.updateNode(n.id, patch),
            onDelete: () => handlers.deleteNode(n.id),
            onPromoteToVault: () => handlers.promoteTempToVault(n.id),
            savedW: n.w,
            savedH: n.h,
            onResize: (w: number, h: number) => handlers.updateNode(n.id, { w, h } as Partial<WorkspaceNode>),
            onWorkspaceNodeLinkDrop: (sourceNodeId: string) => {
              if (sourceNodeId === n.id) return;
              handlers.addEdgeBetween(sourceNodeId, n.id);
            },
            // 拖一张实体卡 drop 到本 temp → workspace edge
            onCardLinkDrop: (sourceLuhmannId: string) => {
              const sourceNode = ws.nodes.find(
                (m) => m.kind === 'card' && (m as { cardId?: string }).cardId === sourceLuhmannId,
              );
              if (!sourceNode || sourceNode.id === n.id) return;
              handlers.addEdgeBetween(sourceNode.id, n.id);
            },
          } as unknown as Record<string, unknown>,
        };
      });
      const nodeKinds = new Map(ws.nodes.map((n) => [n.id, n.kind] as const));
      const wsEdges: Edge[] = dedupeWorkspaceEdges(ws.edges).map((e) => {
        const sourceKind = nodeKinds.get(e.source) ?? 'card';
        const targetKind = nodeKinds.get(e.target) ?? 'card';
        const bothCards = sourceKind === 'card' && targetKind === 'card';
        const readonlyVaultEdge = !!e.vaultLink || !!e.vaultStructure || e.label === 'tree';
        const vaultLikeEdge = !!e.applied || readonlyVaultEdge;
        // Edges with a temp endpoint: dotted, no Apply button — they auto-materialize
        // when the temp is promoted to a vault card.
        // Card↔card: dashed when not applied, solid blue-gray when applied.
        const defaultVaultStroke = e.vaultStructure || e.label === 'tree' ? '#9ca3af' : '#385f73';
        const styleBase = bothCards
          ? vaultLikeEdge
            ? { stroke: defaultVaultStroke, strokeWidth: 2 }
            : { stroke: e.color ?? '#9ca3af', strokeWidth: 1.5, strokeDasharray: '6 4' }
          : { stroke: e.color ?? '#536253', strokeWidth: 1.5, strokeDasharray: '2 4' };
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? undefined,
          targetHandle: e.targetHandle ?? undefined,
          label: e.label,
          type: 'wsApply',
          data: {
            applied: !!e.applied,
            vaultLink: !!e.vaultLink,
            vaultStructure: !!e.vaultStructure || e.label === 'tree',
            workspaceId: ws.id,
            edgeId: e.id,
            bothCards,
            sourceKind,
            targetKind,
            label: e.label,
            color: vaultLikeEdge ? undefined : e.color,
            note: e.note,
          } as unknown as Record<string, unknown>,
          style: styleBase,
        };
      });
      return { nodes: wsNodes, edges: wsEdges };
    },
    [resourceMap],
  );

  const relationCounts = useMemo(() => {
    const ws = wsQ.data;
    const counts: Record<RelationFilter, number> = {
      all: 0,
      draft: 0,
      vault: 0,
      temp: 0,
      workspace: 0,
    };
    if (!ws) return counts;
    const nodeKinds = new Map(ws.nodes.map((n) => [n.id, n.kind] as const));
    for (const edge of dedupeWorkspaceEdges(ws.edges)) {
      const kind = workspaceRelationKind(edge, nodeKinds);
      counts.all += 1;
      counts[kind] += 1;
    }
    return counts;
  }, [wsQ.data]);

  // —— 自动保存（debounced）。保存完同步刷新 ws-links-batch，让主画布看到新边
  const saveTimer = useRef<number | null>(null);
  const persist = useCallback(
    (next: Workspace) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        api
          .updateWorkspace(next.id, { nodes: next.nodes, edges: next.edges })
          .then(() => {
            // 主画布的 workspace-links overlay 依赖这个 query
            qc.invalidateQueries({ queryKey: ['ws-links-batch'] });
          })
          .catch((err) => console.error('save workspace failed', err));
      }, 400);
    },
    [qc],
  );

  // —— 修改 ws data 的辅助函数
  const mutateWs = useCallback(
    (mutator: (ws: Workspace) => Workspace) => {
      qc.setQueryData<Workspace>(['workspace', workspaceId], (old) => {
        if (!old) return old;
        const next = mutator({ ...old, nodes: [...old.nodes], edges: [...old.edges] });
        persist(next);
        return next;
      });
    },
    [qc, workspaceId, persist],
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<WorkspaceNode>) => {
      mutateWs((ws) => ({
        ...ws,
        nodes: ws.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as WorkspaceNode) : n)),
      }));
    },
    [mutateWs],
  );

  const deleteNode = useCallback(
    async (id: string) => {
      // 走后端 endpoint：temp 节点自动入 .zettel/temp-trash/，card/note 直接移除
      try {
        await api.deleteWorkspaceNode(workspaceId, id);
        qc.invalidateQueries({ queryKey: ['workspace', workspaceId] });
        qc.invalidateQueries({ queryKey: ['ws-links-batch'] });
      } catch (err) {
        dialog.alert((err as Error).message, { title: 'Delete failed' });
      }
    },
    [workspaceId, qc],
  );

  const addNote = useCallback(
    (x: number, y: number) => {
      mutateWs((ws) => ({
        ...ws,
        nodes: [...ws.nodes, { kind: 'note', id: randomUUID(), content: '', x, y } as WorkspaceNode],
      }));
    },
    [mutateWs],
  );

  const addTempCard = useCallback(
    (x: number, y: number) => {
      mutateWs((ws) => ({
        ...ws,
        nodes: [
          ...ws.nodes,
          { kind: 'temp', id: randomUUID(), title: '', content: '', x, y } as WorkspaceNode,
        ],
      }));
    },
    [mutateWs],
  );

  const addCardRef = useCallback(
    (cardId: string) => {
      const trimmed = cardId.trim();
      if (!trimmed) return;
      mutateWs((ws) => {
        if (ws.nodes.some((n) => n.kind === 'card' && n.cardId === trimmed)) {
          return ws; // 已存在
        }
        return {
          ...ws,
          nodes: [
            ...ws.nodes,
            { kind: 'card', id: randomUUID(), cardId: trimmed, x: 200, y: 200 } as WorkspaceNode,
          ],
        };
      });
    },
    [mutateWs],
  );

  const addResourceRefAt = useCallback(
    (resourceId: string, x: number, y: number) => {
      const trimmed = resourceId.trim();
      if (!trimmed) return;
      mutateWs((ws) => {
        if (ws.nodes.some((n) => n.kind === 'resource' && n.resourceId === trimmed)) return ws;
        return {
          ...ws,
          nodes: [
            ...ws.nodes,
            { kind: 'resource', id: randomUUID(), resourceId: trimmed, x, y } as WorkspaceNode,
          ],
        };
      });
    },
    [mutateWs],
  );

  const createResourcesFromFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    const flowPos = reactFlow.screenToFlowPosition({
      x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
      y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2,
    });
    let offset = 0;
    try {
      for (const file of files) {
        const resource = await api.uploadResource(file, {
          title: file.name.replace(/\.[^.]+$/, ''),
        });
        addResourceRefAt(resource.id, flowPos.x - 130 + offset, flowPos.y - 100 + offset);
        offset += 28;
      }
      await qc.invalidateQueries({ queryKey: ['resources'] });
      await qc.invalidateQueries({ queryKey: ['tags'] });
    } catch (err) {
      await dialog.alert((err as Error).message, { title: 'Create resource failed' });
    }
  }, [addResourceRefAt, qc, reactFlow]);

  useEffect(() => {
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
  }, [createResourcesFromFiles]);

  const [addCardInput, setAddCardInput] = useState('');
  const [promotePicker, setPromotePicker] = useState<{
    nodeId: string;
    candidates: string[];
  } | null>(null);

  const confirmPromoteTemp = useCallback(
    async (nodeId: string, parentId: string | null) => {
      try {
        const { luhmannId } = await api.nextChildId(parentId);
        const ok = await dialog.confirm(
          `Promote as ${luhmannId}? (under ${parentId ?? 'top-level'})`,
          {
            title: 'Confirm promote',
            confirmLabel: 'Promote',
          },
        );
        if (!ok) return;
        const result = await api.tempToVault(workspaceId, nodeId, luhmannId);
        qc.invalidateQueries({ queryKey: ['workspace', workspaceId] });
        qc.invalidateQueries({ queryKey: ['cards'] });
        qc.invalidateQueries({ queryKey: ['card'] });
        qc.invalidateQueries({ queryKey: ['linked'] });
        qc.invalidateQueries({ queryKey: ['ws-links-batch'] });
        // 部分 edge 物化失败 → 提示用户（卡本身已建好，但 [[link]] 没写完）
        if (result.failedEdges && result.failedEdges.length > 0) {
          dialog.alert(
            `Card created as ${luhmannId}, but ${result.failedEdges.length} workspace edge(s) failed to materialize: ${result.failedEdges.join(', ')}. You can manually re-apply them.`,
            { title: 'Partial promotion' },
          );
        }
      } catch (err) {
        dialog.alert((err as Error).message, { title: 'Promote failed' });
      }
    },
    [workspaceId, qc],
  );

  const promoteTempToVault = useCallback(
    async (nodeId: string) => {
      const ws = wsQ.data;
      if (!ws) return;
      const linkedCardIds = new Set<string>();
      for (const e of ws.edges) {
        const otherNodeId =
          e.source === nodeId ? e.target : e.target === nodeId ? e.source : null;
        if (!otherNodeId) continue;
        const other = ws.nodes.find((n) => n.id === otherNodeId);
        if (other && other.kind === 'card') linkedCardIds.add((other as { cardId: string }).cardId);
      }
      setPromotePicker({ nodeId, candidates: [...linkedCardIds] });
    },
    [wsQ.data],
  );

  const onConnect: OnConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      if (conn.source === conn.target) return;
      mutateWs((ws) => {
        const sourceNode = ws.nodes.find((node) => node.id === conn.source);
        const targetNode = ws.nodes.find((node) => node.id === conn.target);
        if (sourceNode?.kind === 'note' || targetNode?.kind === 'note') return ws;
        const edges = dedupeWorkspaceEdges(ws.edges);
        if (hasWorkspacePair(edges, conn.source!, conn.target!)) return { ...ws, edges };
        return {
          ...ws,
          edges: [
            ...edges,
            {
              id: randomUUID(),
              source: conn.source!,
              target: conn.target!,
              sourceHandle: conn.sourceHandle,
              targetHandle: conn.targetHandle,
            } as WorkspaceEdge,
          ],
        };
      });
    },
    [mutateWs],
  );

  // CardNode 拖卡 → drop on 另一卡 触发的回调（替代用户找 Handle 拖小圆点）
  const addEdgeBetween = useCallback(
    (sourceWsNodeId: string, targetWsNodeId: string) => {
      if (sourceWsNodeId === targetWsNodeId) return;
      mutateWs((ws) => {
        const sourceNode = ws.nodes.find((node) => node.id === sourceWsNodeId);
        const targetNode = ws.nodes.find((node) => node.id === targetWsNodeId);
        if (sourceNode?.kind === 'note' || targetNode?.kind === 'note') return ws;
        const edges = dedupeWorkspaceEdges(ws.edges);
        // Workspace card links are semantic relationships, not separate A→B/B→A arrows.
        if (hasWorkspacePair(edges, sourceWsNodeId, targetWsNodeId)) return { ...ws, edges };
        return {
          ...ws,
          edges: [
            ...edges,
            {
              id: randomUUID(),
              source: sourceWsNodeId,
              target: targetWsNodeId,
            } as WorkspaceEdge,
          ],
        };
      });
    },
    [mutateWs],
  );

  // ws 数据更新时，同步到 ReactFlow state（合并位置）
  useEffect(() => {
    if (!wsQ.data) return;
    const built = buildNodes(wsQ.data, { updateNode, deleteNode, promoteTempToVault, addEdgeBetween });
    setNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return built.nodes.map((n) => ({
        ...n,
        position: prevPos.get(n.id) ?? n.position,
      }));
    });
    setEdges(built.edges.filter((edge) => edgeMatchesRelationFilter(edge, relationFilter)));
  }, [wsQ.data, buildNodes, updateNode, deleteNode, promoteTempToVault, addEdgeBetween, relationFilter, setNodes, setEdges]);

  // 拖动结束 → 同步位置到 workspace data
  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      mutateWs((ws) => ({
        ...ws,
        nodes: ws.nodes.map((n) =>
          n.id === node.id ? ({ ...n, x: node.position.x, y: node.position.y } as WorkspaceNode) : n,
        ),
      }));
    },
    [mutateWs],
  );

  const exportImage = useCallback(async () => {
    try {
      await exportReactFlowCanvasAsPng({
        flowRoot: containerRef.current,
        nodes,
        fileName: `folium-workspace-${wsQ.data?.name ?? workspaceId}`,
      });
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Export image failed' });
    }
  }, [nodes, workspaceId, wsQ.data?.name]);

  // —— 拖卡入工作区
  const [dragHover, setDragHover] = useState(false);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!isCardDrag(e) && !isResourceDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragHover(true);
  }, []);
  const onDragLeave = useCallback(() => setDragHover(false), []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragHover(false);
      const payload = readCardDragData(e);
      const resourcePayload = readResourceDragData(e);
      if (!payload && !resourcePayload) return;
      // screen → flow 坐标
      const flowPos = reactFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      if (resourcePayload) {
        addResourceRefAt(resourcePayload.resourceId, flowPos.x - 130, flowPos.y - 100);
        return;
      }
      if (!payload) return;
      if (payload.workspaceNodeId) return;
      // 居中到落点（card 视觉宽 ~340）
      mutateWs((ws) => {
        if (ws.nodes.some((n) => n.kind === 'card' && n.cardId === payload.luhmannId)) {
          return ws;
        }
        return {
          ...ws,
          nodes: [
            ...ws.nodes,
            {
              kind: 'card',
              id: randomUUID(),
              cardId: payload.luhmannId,
              x: flowPos.x - 170,
              y: flowPos.y - 80,
            } as WorkspaceNode,
          ],
        };
      });
    },
    [addResourceRefAt, reactFlow, mutateWs],
  );

  if (wsQ.isLoading) return <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">{t('workspace.loading', {}, language)}</div>;
  if (wsQ.error || !wsQ.data)
    return <div className="w-full h-full flex items-center justify-center text-sm text-red-500">{String(wsQ.error ?? t('workspace.notFound', {}, language))}</div>;

  return (
    <div
      ref={containerRef}
      className={`w-full h-full relative zk-canvas-bg transition-colors ${dragHover ? 'bg-accentSoft/40' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Toolbar —— 之前的 dock/fullscreen/close 按钮在 pane 系统下都被 tab 系统替代了 */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-1 zk-toolbar-surface px-2 py-1.5 rounded-lg border">
        <RenamableName
          value={wsQ.data.name}
          onSave={(name) => {
            if (!name.trim()) return;
            api.updateWorkspace(workspaceId, { name: name.trim() }).then(() => {
              qc.invalidateQueries({ queryKey: ['workspace', workspaceId] });
              qc.invalidateQueries({ queryKey: ['workspaces'] });
            });
          }}
          className="text-[13px] font-bold text-ink ml-1"
        />
        <span className="text-[10px] text-gray-400">
          {wsQ.data.nodes.length} {t('workspace.nodes', {}, language)} · {wsQ.data.edges.length} {t('workspace.edges', {}, language)}
        </span>
        <div className="border-l border-paperEdge/80 mx-1 h-4" />
        <button
          onClick={() => addNote(200, 200)}
          className="flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded border border-transparent text-[#9a6a2f] dark:text-[#eed49f] hover:text-ink hover:border-[#d6c09b] dark:hover:border-[#eed49f]/40 hover:bg-[#f3e6c8]/70 dark:hover:bg-[#eed49f]/12"
          title={t('workspace.note', {}, language)}
        >
          <StickyNote size={12} /> {t('workspace.note', {}, language)}
        </button>
        <button
          onClick={() => addTempCard(400, 200)}
          className="flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded border border-transparent text-accent hover:text-ink hover:border-accent/30 hover:bg-accentSoft"
          title={t('workspace.tempCard', {}, language)}
        >
          <FilePlus size={12} /> {t('workspace.tempCard', {}, language)}
        </button>
        <input
          ref={resourceInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = '';
            void createResourcesFromFiles(files);
          }}
        />
        <button
          onClick={() => resourceInputRef.current?.click()}
          className="flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded border border-transparent text-[#9a6a2f] dark:text-[#eed49f] hover:text-ink hover:border-[#d6c09b] dark:hover:border-[#eed49f]/40 hover:bg-[#f3e6c8]/70 dark:hover:bg-[#eed49f]/12"
          title={t('workspace.resource', {}, language)}
        >
          <PackageOpen size={12} /> {t('workspace.resource', {}, language)}
        </button>
        <div className="border-l border-paperEdge/80 mx-1 h-4" />
        <div className="relative">
          <button
            onClick={() => setRelationMenuOpen((open) => !open)}
            className="zk-subtle-button border flex items-center gap-1.5 text-[10px] font-bold px-2 py-1 rounded-full transition-colors"
            title={t('workspace.relations', {}, language)}
          >
            {t('workspace.relations', {}, language)}
            <span className="text-gray-500 dark:text-[#a5adcb]">
              {relationShortLabel(relationFilter, language)}
            </span>
            <span className="text-gray-500 dark:text-[#a5adcb]">{relationCounts[relationFilter]}</span>
            <ChevronDown size={11} />
          </button>
          {relationMenuOpen && (
            <div className="absolute left-0 top-8 z-[2300] w-64 overflow-hidden rounded-lg border border-paperEdge bg-paper text-ink shadow-2xl">
              {RELATION_FILTER_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  onClick={() => {
                    chooseRelationFilter(option.id);
                    setRelationMenuOpen(false);
                  }}
                  className={`w-full px-3 py-2 text-left transition-colors ${
                    relationFilter === option.id ? 'bg-accentSoft text-ink' : 'text-ink hover:bg-surfaceAlt'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-bold">{relationLabel(option.id, language)}</span>
                    <span className="font-mono text-[10px] text-gray-500 dark:text-[#a5adcb]">{relationCounts[option.id]}</span>
                  </div>
                  <div className="mt-0.5 text-[10px] leading-snug text-gray-500 dark:text-[#a5adcb]">{relationDescription(option.id, language)}</div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="border-l border-paperEdge/80 mx-1 h-4" />
        <input
          value={addCardInput}
          onChange={(e) => setAddCardInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              addCardRef(addCardInput);
              setAddCardInput('');
            }
          }}
          placeholder={t('workspace.cardIdPlaceholder', {}, language)}
          className="w-24 text-[11px] font-mono px-2 py-0.5 border border-paperEdge rounded bg-paper/80 focus:border-accent outline-none"
        />
        <button
          onClick={() => {
            addCardRef(addCardInput);
            setAddCardInput('');
          }}
          className="flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded border border-transparent text-accent hover:text-ink hover:border-accent/30 hover:bg-accentSoft"
          title={t('workspace.addCard', {}, language)}
        >
          <Layers size={12} /> {t('workspace.addCard', {}, language)}
        </button>
      </div>

      {/* Empty-state hint */}
      {wsQ.data.nodes.length === 0 && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 text-center text-gray-400 text-sm pointer-events-none">
          {t('workspace.emptyHint', {}, language)}<br/>
          <span className="text-[11px]">{t('workspace.emptyHintApply', {}, language)}</span>
        </div>
      )}
      {promotePicker && (
        <ParentCardPicker
          candidates={promotePicker.candidates}
          onClose={() => setPromotePicker(null)}
          onPick={(parentId) => {
            const nodeId = promotePicker.nodeId;
            setPromotePicker(null);
            void confirmPromoteTemp(nodeId, parentId);
          }}
        />
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1, minZoom: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background id={`ws-bg-${workspaceId}`} gap={24} size={1.2} color="rgba(116,120,120,0.20)" />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap pannable zoomable position="top-right" maskColor="rgba(83,98,83,0.07)" />
      </ReactFlow>
      <button
        type="button"
        className="absolute bottom-[116px] right-4 z-20 flex h-[31px] w-[31px] items-center justify-center rounded-full border border-paperEdge bg-paper/85 text-muted shadow-paper backdrop-blur transition-colors hover:bg-accentSoft hover:text-ink hover:border-accent/35"
        title="Export workspace as PNG"
        aria-label="Export workspace as PNG"
        onClick={() => void exportImage()}
      >
        <Download size={13} strokeWidth={2.4} />
      </button>
    </div>
  );
}

const nodeTypes = {
  card: CardNode,
  wsNote: WorkspaceNoteNode,
  wsTemp: WorkspaceTempNode,
  resource: ResourceNode,
};

function ParentCardPicker({
  candidates,
  onClose,
  onPick,
}: {
  candidates: string[];
  onClose: () => void;
  onPick: (parentId: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const typedParentId = query.trim();
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const candidateSet = new Set(candidates);
  const cards = cardsQ.data?.cards ?? [];
  const filtered = cards
    .filter((card) => {
      const q = query.trim().toLowerCase();
      if (!q) return candidateSet.has(card.luhmannId) || card.status === 'INDEX';
      return `${card.luhmannId} ${card.title}`.toLowerCase().includes(q);
    })
    .slice(0, 80);

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/30 backdrop-blur-[2px]">
      <div className="w-[520px] max-w-[92vw] max-h-[82vh] flex flex-col bg-white dark:bg-[#1e2030] border border-gray-200 dark:border-[#363a4f] rounded-lg shadow-2xl">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-[#363a4f]">
          <div className="text-sm font-bold text-ink dark:text-[#cad3f5]">Pick parent card</div>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or type parent id"
            className="mt-3 w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-[#494d64] rounded outline-none focus:border-accent bg-white dark:bg-[#24273a]"
          />
          {typedParentId && (
            <button
              onClick={() => onPick(typedParentId)}
              className="mt-2 w-full text-left px-2 py-1.5 rounded border border-accent/30 text-xs font-bold text-accent hover:bg-accentSoft"
            >
              Use typed id: <span className="font-mono">{typedParentId}</span>
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          <button
            onClick={() => onPick(null)}
            className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-[#363a4f]"
          >
            <div className="text-sm font-semibold">Top level</div>
            <div className="text-[10px] uppercase tracking-widest text-gray-400">No parent</div>
          </button>
          {filtered.map((card) => (
            <button
              key={card.luhmannId}
              onClick={() => onPick(card.luhmannId)}
              className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-[#363a4f]"
            >
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="font-mono text-[11px] font-bold text-accent shrink-0">{card.luhmannId}</span>
                <span className="text-sm font-semibold truncate">{card.title || card.luhmannId}</span>
                {candidateSet.has(card.luhmannId) && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-accentSoft text-accent">
                    linked
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
        <div className="px-4 py-3 flex justify-end border-t border-gray-100 dark:border-[#363a4f]">
          <button onClick={onClose} className="text-xs font-bold px-3 py-1.5 rounded text-gray-600 hover:bg-gray-100">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* -------- 自定义 Edge：带 apply/unapply 按钮 -------- */
function ApplyEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style }: EdgeProps) {
  const qc = useQueryClient();
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const d = data as unknown as
    | {
        applied: boolean;
        vaultLink: boolean;
        vaultStructure: boolean;
        workspaceId: string;
        edgeId: string;
        bothCards: boolean;
        sourceKind: 'card' | 'temp' | 'note';
        targetKind: 'card' | 'temp' | 'note';
        label?: string;
        color?: string;
        note?: string;
      }
    | undefined;
  const [metaOpen, setMetaOpen] = useState(false);
  const [draftLabel, setDraftLabel] = useState(d?.label ?? '');
  const [draftNote, setDraftNote] = useState(d?.note ?? '');
  const [draftColor, setDraftColor] = useState(d?.color ?? '#385f73');
  const edgeDx = targetX - sourceX;
  const edgeDy = targetY - sourceY;
  const edgeLength = Math.max(1, Math.hypot(edgeDx, edgeDy));
  const shortEdgeSlide = Math.max(0, Math.min(0.12, ((280 - edgeLength) / 280) * 0.12));
  const labelT = sourceX <= targetX ? 0.5 - shortEdgeSlide : 0.5 + shortEdgeSlide;
  const sourceControl = bezierControlPoint({
    position: sourcePosition,
    x1: sourceX,
    y1: sourceY,
    x2: targetX,
    y2: targetY,
  });
  const targetControl = bezierControlPoint({
    position: targetPosition,
    x1: targetX,
    y1: targetY,
    x2: sourceX,
    y2: sourceY,
  });
  const bothRealCards = !!d && (d.bothCards || (d.sourceKind === 'card' && d.targetKind === 'card'));
  const hasTempEndpoint = d?.sourceKind === 'temp' || d?.targetKind === 'temp';
  const relationKind = d?.vaultLink
    ? 'vault'
    : d?.vaultStructure
      ? 'tree'
      : d?.applied
        ? 'applied'
        : bothRealCards
          ? 'draft-link'
          : hasTempEndpoint
            ? 'temp'
            : 'workspace';
  const relationBadge = {
    'draft-link': {
      label: '双链',
      cls: 'border-amber-300 bg-amber-50 text-amber-700 hover:border-amber-400',
    },
    temp: {
      label: 'temp',
      cls: 'border-accent/30 bg-accentSoft text-accent hover:border-accent/50',
    },
    vault: {
      label: 'vault',
      cls: 'border-sky-300 bg-sky-50 text-sky-700 hover:border-sky-400',
    },
    tree: {
      label: 'tree',
      cls: 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:border-emerald-400',
    },
    applied: {
      label: 'applied',
      cls: 'border-accent/40 bg-accentSoft text-accent hover:border-accent/60',
    },
    workspace: {
      label: 'workspace',
      cls: 'border-gray-300 bg-white text-gray-600 hover:border-gray-400',
    },
  }[relationKind];
  const metadataEditable = !(d?.vaultLink || d?.vaultStructure);
  const invalidateCardData = () => {
    qc.invalidateQueries({ queryKey: ['workspace', d!.workspaceId] });
    qc.invalidateQueries({ queryKey: ['cards'] });
    qc.invalidateQueries({ queryKey: ['card'] });
    qc.invalidateQueries({ queryKey: ['linked'] });
    qc.invalidateQueries({ queryKey: ['related-batch'] });
    qc.invalidateQueries({ queryKey: ['referenced-from'] });
    // 关键：vault 主画布上的 temp ghost / workspace edge 是从 ws-links-batch 拉的，
    // 不刷新这条 → 删完 workspace edge 后主画布还显示 stale ghost 卡和虚线
    qc.invalidateQueries({ queryKey: ['ws-links-batch'] });
  };
  const applyMut = useMutation({
    mutationFn: () => api.applyEdge(d!.workspaceId, d!.edgeId),
    onSuccess: () => {
      setMetaOpen(false);
      invalidateCardData();
    },
    onError: (err: Error) => {
      dialog.alert(err.message, { title: 'Apply failed' });
    },
  });
  const unapplyMut = useMutation({
    mutationFn: () => api.unapplyEdge(d!.workspaceId, d!.edgeId),
    onSuccess: () => {
      setMetaOpen(false);
      invalidateCardData();
    },
    onError: (err: Error) => {
      dialog.alert(err.message, { title: 'Unapply failed' });
    },
  });
  const deleteMut = useMutation({
    mutationFn: () => api.deleteWorkspaceEdge(d!.workspaceId, d!.edgeId),
    onSuccess: () => {
      setMetaOpen(false);
      invalidateCardData();
    },
    onError: (err: Error) => {
      dialog.alert(err.message, { title: 'Delete failed' });
    },
  });
  const updateEdge = async (patch: Partial<WorkspaceEdge>) => {
    if (!d) return;
    const ws = await api.getWorkspace(d.workspaceId);
    const next = await api.updateWorkspace(d.workspaceId, {
      edges: ws.edges.map((edge) => (edge.id === d.edgeId ? { ...edge, ...patch } : edge)),
    });
    qc.setQueryData(['workspace', d.workspaceId], next);
    qc.invalidateQueries({ queryKey: ['workspaces'] });
    qc.invalidateQueries({ queryKey: ['ws-links-batch'] });
  };
  const saveMeta = async () => {
    const color = draftColor.trim();
    await updateEdge({
      label: draftLabel.trim() || undefined,
      note: draftNote.trim() || undefined,
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined,
    });
    setMetaOpen(false);
  };
  const onDelete = async () => {
    if (deleteMut.isPending) return;
    const ok = await dialog.confirm('Delete this edge?', {
      title: 'Delete edge',
      description: d?.applied
        ? 'The edge has been applied to the vault. The [[link]] in the source card will be removed too.'
        : undefined,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    deleteMut.mutate();
  };
  const { x: labelX, y: labelY } = cubicBezierPoint(
    labelT,
    { x: sourceX, y: sourceY },
    sourceControl,
    targetControl,
    { x: targetX, y: targetY },
  );
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} />
      <EdgeLabelRenderer>
        <div
          className="absolute z-[1500] pointer-events-auto"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              setDraftLabel(d?.label ?? '');
              setDraftNote(d?.note ?? '');
              setDraftColor(d?.color ?? '#385f73');
              setMetaOpen((open) => !open);
            }}
            className={`max-w-36 truncate text-[10px] font-bold px-2 py-0.5 rounded-full border shadow-sm transition-colors ${relationBadge.cls}`}
            title={d?.note || (metadataEditable ? 'Edit workspace link' : 'Vault link')}
          >
            {d?.label || relationBadge.label}
          </button>
          {metaOpen && d && (
            <div
              className="absolute left-1/2 top-7 z-[2200] w-[380px] max-w-[92vw] -translate-x-1/2 rounded-lg border border-gray-200 bg-white shadow-2xl dark:border-[#363a4f] dark:bg-[#1e2030]"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2 dark:border-[#363a4f]">
                <div className="min-w-0">
                  <div className="truncate text-xs font-bold text-ink dark:text-[#cad3f5]">
                    {bothRealCards ? '双链关系' : 'Workspace relation'}
                  </div>
                  <div className="truncate text-[10px] text-gray-400">
                    {bothRealCards
                      ? d.applied
                        ? 'Already written to the vault'
                        : d.vaultLink || d.vaultStructure
                          ? 'Already exists in the vault'
                          : 'Draft link between two real cards'
                      : hasTempEndpoint
                        ? 'Temp edge; materializes when promoted'
                        : 'Workspace-only relation'}
                  </div>
                </div>
                <button onClick={() => setMetaOpen(false)} className="shrink-0 text-gray-400 hover:text-gray-600">
                  <X size={13} />
                </button>
              </div>
              {metadataEditable ? (
                <div className="space-y-2 p-3">
                  <input
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs outline-none focus:border-accent dark:border-[#494d64] dark:bg-[#24273a]"
                    placeholder="Label: supports, example, contradicts"
                  />
                  <textarea
                    value={draftNote}
                    onChange={(e) => setDraftNote(e.target.value)}
                    className="min-h-20 w-full resize-y rounded border border-gray-300 px-2 py-1.5 text-xs outline-none focus:border-accent dark:border-[#494d64] dark:bg-[#24273a]"
                    placeholder="Why are these cards connected?"
                  />
                  <div className="flex items-center gap-2">
                    {['#385f73', '#536253', '#ba635c', '#f59e0b', '#ef4444'].map((color) => (
                      <button
                        key={color}
                        onClick={() => setDraftColor(color)}
                        className={`h-5 w-5 rounded border-2 ${draftColor === color ? 'border-ink dark:border-[#cad3f5]' : 'border-white shadow'}`}
                        style={{ backgroundColor: color }}
                        title={color}
                      />
                    ))}
                    <input
                      value={draftColor}
                      onChange={(e) => setDraftColor(e.target.value)}
                      className="ml-auto w-24 rounded border border-gray-300 px-2 py-1 text-[11px] font-mono outline-none focus:border-accent dark:border-[#494d64] dark:bg-[#24273a]"
                    />
                  </div>
                </div>
              ) : (
                <div className="p-3 text-xs text-gray-500 dark:text-[#a5adcb]">
                  This relation is already represented by the vault. Workspace label and note are shown here, but color is not applied to real vault links.
                  {(d.label || d.note) && (
                    <div className="mt-2 rounded border border-paperEdge bg-surfaceAlt/70 p-2">
                      {d.label && <div className="font-bold text-ink dark:text-[#cad3f5]">{d.label}</div>}
                      {d.note && <div className="mt-1 whitespace-pre-wrap">{d.note}</div>}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2 border-t border-gray-100 px-3 py-2 dark:border-[#363a4f]">
                {bothRealCards && !d.vaultLink && !d.vaultStructure && !d.applied && (
                  <button
                    onClick={async () => {
                      const ok = await dialog.confirm('Write this edge into the vault as a real [[link]] in the source card?', {
                        title: 'Apply edge',
                        confirmLabel: 'Apply',
                      });
                      if (ok) applyMut.mutate();
                    }}
                    className="flex items-center gap-1 rounded-full border zk-subtle-button px-2.5 py-1.5 text-[11px] font-bold shadow-sm hover:text-accent"
                  >
                    <Link2 size={11} />
                    Link
                  </button>
                )}
                {bothRealCards && d.applied && !d.vaultLink && !d.vaultStructure && (
                  <button
                    onClick={async () => {
                      const ok = await dialog.confirm('Remove this edge’s [[link]] from the vault?', {
                        title: 'Unapply edge',
                        confirmLabel: 'Unapply',
                        variant: 'danger',
                      });
                      if (ok) unapplyMut.mutate();
                    }}
                    className="flex items-center gap-1 rounded bg-accent px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-accent/90"
                  >
                    <Undo2 size={11} /> Unapply
                  </button>
                )}
                <button
                  onClick={onDelete}
                  className="rounded px-2.5 py-1.5 text-[11px] font-bold text-red-600 hover:bg-red-50"
                >
                  Delete
                </button>
                <div className="flex-1" />
                <button
                  onClick={() => setMetaOpen(false)}
                  className="rounded px-2.5 py-1.5 text-[11px] font-bold text-gray-600 hover:bg-gray-100 dark:text-[#a5adcb] dark:hover:bg-[#363a4f]"
                >
                  Cancel
                </button>
                {metadataEditable && (
                  <button
                    onClick={() => void saveMeta()}
                    className="rounded bg-accent px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-accent/90"
                  >
                    Save
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { wsApply: ApplyEdge };
