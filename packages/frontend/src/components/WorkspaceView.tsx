import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
        // Edges with a temp endpoint: dotted, no Apply button — they auto-materialize
        // when the temp is promoted to a vault card.
        // Card↔card: dashed when not applied, solid purple when applied.
        const styleBase = bothCards
          ? e.applied
            ? { stroke: '#7c4dff', strokeWidth: 2 }
            : { stroke: '#9ca3af', strokeWidth: 1.5, strokeDasharray: '6 4' }
          : { stroke: '#a78bfa', strokeWidth: 1.5, strokeDasharray: '2 4' };
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
            workspaceId: ws.id,
            edgeId: e.id,
            bothCards,
            sourceKind,
            targetKind,
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
    (id: string) => {
      mutateWs((ws) => ({
        ...ws,
        nodes: ws.nodes.filter((n) => n.id !== id),
        edges: ws.edges.filter((e) => e.source !== id && e.target !== id),
      }));
    },
    [mutateWs],
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

  /**
   * 智能提权 temp 卡：
   *   - 1 个 workspace edge → 自动用对端卡作为 parent，next-available 子 id
   *   - 0 / 多个 → prompt 让用户敲父级 id（空 = 顶层）
   * 始终算出 next id 后再调 tempToVault。
   */
  const promoteTempToVault = useCallback(
    async (nodeId: string) => {
      const ws = wsQ.data;
      if (!ws) return;

      // 收集所有跟此 temp 相连的实体卡 id（去重）
      const linkedCardIds = new Set<string>();
      for (const e of ws.edges) {
        const otherNodeId =
          e.source === nodeId ? e.target : e.target === nodeId ? e.source : null;
        if (!otherNodeId) continue;
        const other = ws.nodes.find((n) => n.id === otherNodeId);
        if (other && other.kind === 'card') {
          linkedCardIds.add((other as { cardId: string }).cardId);
        }
      }
      const candidates = [...linkedCardIds];

      let parentId: string | null;
      if (candidates.length === 1) {
        parentId = candidates[0]!;
      } else if (candidates.length > 1) {
        // 多个候选 → 让用户挑一个
        const picked = await dialog.prompt(
          `This temp links to ${candidates.length} cards: ${candidates.join(', ')}\n\nType which one to use as parent (or empty for top-level):`,
          {
            title: 'Promote — pick parent',
            defaultValue: candidates[0]!,
            confirmLabel: 'Promote',
          },
        );
        if (picked === null) return;
        parentId = picked.trim() || null;
        if (parentId && !candidates.includes(parentId)) {
          // 用户敲的不在候选里 → 仍允许，但要求是合法卡
          // 后端会校验 parent 存在
        }
      } else {
        // 没有 edge → 让用户手动选父级
        const picked = await dialog.prompt(
          'Type parent id (empty for top-level):',
          {
            title: 'Promote — pick parent',
            defaultValue: '',
            confirmLabel: 'Promote',
          },
        );
        if (picked === null) return;
        parentId = picked.trim() || null;
      }

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
    [workspaceId, qc, wsQ.data],
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
        workspaceId: string;
        edgeId: string;
        bothCards: boolean;
        sourceKind: 'card' | 'temp' | 'note';
        targetKind: 'card' | 'temp' | 'note';
      }
    | undefined;
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
    onSuccess: invalidateCardData,
    onError: (err: Error) => {
      dialog.alert(err.message, { title: 'Apply failed' });
    },
  });
  const unapplyMut = useMutation({
    mutationFn: () => api.unapplyEdge(d!.workspaceId, d!.edgeId),
    onSuccess: invalidateCardData,
    onError: (err: Error) => {
      dialog.alert(err.message, { title: 'Unapply failed' });
    },
  });
  const deleteMut = useMutation({
    mutationFn: () => api.deleteWorkspaceEdge(d!.workspaceId, d!.edgeId),
    onSuccess: invalidateCardData,
    onError: (err: Error) => {
      dialog.alert(err.message, { title: 'Delete failed' });
    },
  });
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
          className="absolute pointer-events-auto flex items-center gap-1"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          {d?.bothCards ? (
            !d.applied ? (
              <button
                onClick={async () => {
                  if (applyMut.isPending) return;
                  const ok = await dialog.confirm(
                    'Write this edge into the vault as a real [[link]] in the source card?',
                    {
                      title: 'Apply edge',
                      confirmLabel: 'Apply',
                    },
                  );
                  if (!ok) return;
                  applyMut.mutate();
                }}
                disabled={applyMut.isPending}
                className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white border border-accent/40 text-accent hover:bg-accent hover:text-white shadow-sm transition-colors"
                title="Persist this edge into the vault as a real [[link]]"
              >
                {applyMut.isPending ? 'Applying…' : 'Apply'}
              </button>
            ) : (
              <button
                onClick={async () => {
                  if (unapplyMut.isPending) return;
                  const ok = await dialog.confirm(
                    'Remove this edge’s [[link]] from the vault?',
                    {
                      title: 'Unapply edge',
                      confirmLabel: 'Unapply',
                      variant: 'danger',
                    },
                  );
                  if (!ok) return;
                  unapplyMut.mutate();
                }}
                disabled={unapplyMut.isPending}
                className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-accent text-white hover:bg-accent/80 shadow-sm"
                title="Unapply: remove from vault"
              >
                <Undo2 size={9} />
                {unapplyMut.isPending ? 'Unapplying…' : 'Applied'}
              </button>
            )
          ) : (
            // Edge involving a temp/note: no Apply button — auto-materializes when temps are promoted
            <span
              className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-purple-50 border border-purple-200 text-purple-600 select-none"
              title={
                d?.sourceKind === 'temp' || d?.targetKind === 'temp'
                  ? 'Auto-links into the vault when the temp card is promoted'
                  : 'Workspace-only link'
              }
            >
              workspace
            </span>
          )}
          <button
            onClick={onDelete}
            disabled={deleteMut.isPending}
            className="w-4 h-4 rounded-full bg-white border border-gray-300 text-gray-400 hover:bg-red-500 hover:text-white hover:border-red-500 shadow-sm flex items-center justify-center transition-colors"
            title="Delete edge"
          >
            <X size={9} />
          </button>
          {label ? <span className="ml-1 text-[10px] text-gray-500">{label}</span> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { wsApply: ApplyEdge };
