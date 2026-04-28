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
} from '@xyflow/react';
import { isCardDrag, readCardDragData } from '../lib/dragCard';
import { RenamableName } from './RenamableName';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FilePlus,
  Layers,
  StickyNote,
  Undo2,
  X,
  ZoomIn,
} from 'lucide-react';
import { randomUUID } from '../lib/uuid';
import { api, type Workspace, type WorkspaceEdge, type WorkspaceNode } from '../lib/api';
import { dialog } from '../lib/dialog';
import { CardNode } from './CardNode';
import { WorkspaceNoteNode } from './WorkspaceNoteNode';
import { WorkspaceTempNode } from './WorkspaceTempNode';

interface Props {
  workspaceId: string;
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

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

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
            data: {
              card: { luhmannId: n.cardId, title: '', status: 'ATOMIC', tags: [], crossLinks: [], depth: 0, sortKey: '' },
              variant: 'tree',
              isInWorkspace: true,
              onDeleteOverride: () => handlers.deleteNode(n.id),
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
        if (n.kind === 'note') {
          return {
            id: n.id,
            type: 'wsNote',
            position: { x: n.x, y: n.y },
            data: {
              content: n.content,
              onChange: (content: string) => handlers.updateNode(n.id, { content }),
              onDelete: () => handlers.deleteNode(n.id),
            } as unknown as Record<string, unknown>,
          };
        }
        // temp
        return {
          id: n.id,
          type: 'wsTemp',
          position: { x: n.x, y: n.y },
          data: {
            title: n.title,
            content: n.content,
            onChange: (patch: { title?: string; content?: string }) => handlers.updateNode(n.id, patch),
            onDelete: () => handlers.deleteNode(n.id),
            onPromoteToVault: () => handlers.promoteTempToVault(n.id),
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
      const wsEdges: Edge[] = ws.edges.map((e) => {
        const sourceKind = nodeKinds.get(e.source) ?? 'card';
        const targetKind = nodeKinds.get(e.target) ?? 'card';
        const bothCards = sourceKind === 'card' && targetKind === 'card';
        const readonlyVaultEdge = !!e.vaultLink || !!e.vaultStructure || e.label === 'tree';
        // Edges with a temp endpoint: dotted, no Apply button — they auto-materialize
        // when the temp is promoted to a vault card.
        // Card↔card: dashed when not applied, solid purple when applied.
        const stroke = e.color ?? '#7c4dff';
        const styleBase = bothCards
          ? e.applied || readonlyVaultEdge
            ? { stroke, strokeWidth: 2 }
            : { stroke: e.color ?? '#9ca3af', strokeWidth: 1.5, strokeDasharray: '6 4' }
          : { stroke: e.color ?? '#a78bfa', strokeWidth: 1.5, strokeDasharray: '2 4' };
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
            color: e.color,
            note: e.note,
          } as unknown as Record<string, unknown>,
          style: styleBase,
        };
      });
      return { nodes: wsNodes, edges: wsEdges };
    },
    [],
  );

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
      mutateWs((ws) => ({
        ...ws,
        edges: [
          ...ws.edges,
          {
            id: randomUUID(),
            source: conn.source!,
            target: conn.target!,
            sourceHandle: conn.sourceHandle,
            targetHandle: conn.targetHandle,
          } as WorkspaceEdge,
        ],
      }));
    },
    [mutateWs],
  );

  // CardNode 拖卡 → drop on 另一卡 触发的回调（替代用户找 Handle 拖小圆点）
  const addEdgeBetween = useCallback(
    (sourceWsNodeId: string, targetWsNodeId: string) => {
      mutateWs((ws) => {
        // 已有同向同对的 edge → 静默
        const dup = ws.edges.find(
          (e) => e.source === sourceWsNodeId && e.target === targetWsNodeId,
        );
        if (dup) return ws;
        return {
          ...ws,
          edges: [
            ...ws.edges,
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
    setEdges(built.edges);
  }, [wsQ.data, buildNodes, updateNode, deleteNode, promoteTempToVault, addEdgeBetween, setNodes, setEdges]);

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

  const containerRef = useRef<HTMLDivElement>(null);
  const reactFlow = useReactFlow();

  // —— 拖卡入工作区
  const [dragHover, setDragHover] = useState(false);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!isCardDrag(e)) return;
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
      if (!payload) return;
      // screen → flow 坐标
      const flowPos = reactFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
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
    [reactFlow, mutateWs],
  );

  if (wsQ.isLoading) return <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">Loading workspace…</div>;
  if (wsQ.error || !wsQ.data)
    return <div className="w-full h-full flex items-center justify-center text-sm text-red-500">{String(wsQ.error ?? 'Workspace not found')}</div>;

  return (
    <div
      ref={containerRef}
      className={`w-full h-full relative bg-[#fafaf6] transition-colors ${dragHover ? 'bg-accentSoft/40' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Toolbar —— 之前的 dock/fullscreen/close 按钮在 pane 系统下都被 tab 系统替代了 */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-1 bg-white px-2 py-1.5 rounded-lg shadow-md border border-gray-200">
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
          {wsQ.data.nodes.length} nodes · {wsQ.data.edges.length} edges
        </span>
        <div className="border-l border-gray-200 mx-1 h-4" />
        <button
          onClick={() => addNote(200, 200)}
          className="flex items-center gap-1 text-[11px] font-bold text-yellow-700 hover:text-yellow-800 px-2 py-1 rounded hover:bg-yellow-50"
          title="Add sticky note"
        >
          <StickyNote size={12} /> Note
        </button>
        <button
          onClick={() => addTempCard(400, 200)}
          className="flex items-center gap-1 text-[11px] font-bold text-purple-700 hover:text-purple-800 px-2 py-1 rounded hover:bg-purple-50"
          title="Add temporary card"
        >
          <FilePlus size={12} /> Temp card
        </button>
        <div className="border-l border-gray-200 mx-1 h-4" />
        <input
          value={addCardInput}
          onChange={(e) => setAddCardInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              addCardRef(addCardInput);
              setAddCardInput('');
            }
          }}
          placeholder="vault card id"
          className="w-24 text-[11px] font-mono px-2 py-0.5 border border-gray-200 rounded focus:border-accent outline-none"
        />
        <button
          onClick={() => {
            addCardRef(addCardInput);
            setAddCardInput('');
          }}
          className="flex items-center gap-1 text-[11px] font-bold text-emerald-700 hover:text-emerald-800 px-2 py-1 rounded hover:bg-emerald-50"
          title="Add a vault card by luhmannId (e.g. 1a2)"
        >
          <Layers size={12} /> Add card
        </button>
      </div>

      {/* Empty-state hint */}
      {wsQ.data.nodes.length === 0 && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 text-center text-gray-400 text-sm pointer-events-none">
          Click "Note" to add a sticky · drop a vault card here · connect freely<br/>
          <span className="text-[11px]">Then "Apply" an edge to write it back to the vault as a real [[link]]</span>
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
        <Background id={`ws-bg-${workspaceId}`} gap={24} size={1.5} color="#e5e7eb" />
        <Controls position="bottom-right" showInteractive={false}>
          <ZoomIn size={12} />
        </Controls>
        <MiniMap pannable zoomable position="top-right" maskColor="rgba(0,0,0,0.05)" />
      </ReactFlow>
    </div>
  );
}

const nodeTypes = {
  card: CardNode,
  wsNote: WorkspaceNoteNode,
  wsTemp: WorkspaceTempNode,
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
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
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
function ApplyEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style, label }: EdgeProps) {
  const qc = useQueryClient();
  const [edgePath, labelX, labelY] = getBezierPath({
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
  const [draftColor, setDraftColor] = useState(d?.color ?? '#7c4dff');
  const relationKind = d?.vaultLink
    ? 'vault'
    : d?.vaultStructure
      ? 'tree'
      : d?.applied
        ? 'applied'
        : d?.bothCards
          ? 'draft-link'
          : d?.sourceKind === 'temp' || d?.targetKind === 'temp'
            ? 'temp'
            : 'workspace';
  const relationBadge = {
    'draft-link': {
      label: '双链',
      cls: 'border-amber-300 bg-amber-50 text-amber-700 hover:border-amber-400',
    },
    temp: {
      label: 'temp',
      cls: 'border-purple-300 bg-purple-50 text-purple-700 hover:border-purple-400',
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
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} />
      <EdgeLabelRenderer>
        <div
          className="absolute pointer-events-auto"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          <button
            onClick={() => {
              setDraftLabel(d?.label ?? '');
              setDraftNote(d?.note ?? '');
              setDraftColor(d?.color ?? '#7c4dff');
              setMetaOpen((open) => !open);
            }}
            className={`max-w-36 truncate text-[10px] font-bold px-2 py-0.5 rounded-full border shadow-sm transition-colors ${relationBadge.cls}`}
            title={d?.note || 'Edit workspace link'}
          >
            {d?.label || relationBadge.label}
          </button>
          {metaOpen && d && (
            <div
              className="absolute left-1/2 top-7 z-[1000] w-[380px] max-w-[92vw] -translate-x-1/2 rounded-lg border border-gray-200 bg-white shadow-2xl dark:border-[#363a4f] dark:bg-[#1e2030]"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2 dark:border-[#363a4f]">
                <div className="min-w-0">
                  <div className="truncate text-xs font-bold text-ink dark:text-[#cad3f5]">
                    {d.bothCards ? '双链关系' : 'Workspace relation'}
                  </div>
                  <div className="truncate text-[10px] text-gray-400">
                    {d.bothCards
                      ? d.applied
                        ? 'Already written to the vault'
                        : d.vaultLink || d.vaultStructure
                          ? 'Already exists in the vault'
                          : 'Draft link between two real cards'
                      : d.sourceKind === 'temp' || d.targetKind === 'temp'
                        ? 'Temp edge; materializes when promoted'
                        : 'Workspace-only relation'}
                  </div>
                </div>
                <button onClick={() => setMetaOpen(false)} className="shrink-0 text-gray-400 hover:text-gray-600">
                  <X size={13} />
                </button>
              </div>
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
                  {['#7c4dff', '#10b981', '#f59e0b', '#ef4444', '#0ea5e9'].map((color) => (
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
              <div className="flex items-center gap-2 border-t border-gray-100 px-3 py-2 dark:border-[#363a4f]">
                {d.bothCards && !d.vaultLink && !d.vaultStructure && !d.applied && (
                  <button
                    onClick={async () => {
                      const ok = await dialog.confirm('Write this edge into the vault as a real [[link]] in the source card?', {
                        title: 'Apply edge',
                        confirmLabel: 'Apply',
                      });
                      if (ok) applyMut.mutate();
                    }}
                    className="rounded bg-accent px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-accent/90"
                  >
                    Apply
                  </button>
                )}
                {d.bothCards && d.applied && !d.vaultLink && !d.vaultStructure && (
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
                <button
                  onClick={() => void saveMeta()}
                  className="rounded bg-accent px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-accent/90"
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { wsApply: ApplyEdge };
