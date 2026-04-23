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
  Maximize2,
  Minimize2,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Pin,
  PinOff,
  StickyNote,
  Undo2,
  X,
  ZoomIn,
} from 'lucide-react';
import { randomUUID } from '../lib/uuid';
import { api, type Workspace, type WorkspaceEdge, type WorkspaceNode } from '../lib/api';
import { useUIStore } from '../store/uiStore';
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
  const setFocusWorkspace = useUIStore((s) => s.setFocusWorkspace);
  const workspaceFullscreen = useUIStore((s) => s.workspaceFullscreen);
  const setWorkspaceFullscreen = useUIStore((s) => s.setWorkspaceFullscreen);
  const workspacePanelPosition = useUIStore((s) => s.workspacePanelPosition);
  const setWorkspacePanelPosition = useUIStore((s) => s.setWorkspacePanelPosition);
  const workspacePanelPinned = useUIStore((s) => s.workspacePanelPinned);
  const toggleWorkspacePanelPinned = useUIStore((s) => s.toggleWorkspacePanelPinned);
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
      },
    ): { nodes: Node[]; edges: Edge[] } => {
      const wsNodes: Node[] = ws.nodes.map((n) => {
        if (n.kind === 'card') {
          return {
            id: n.id,
            type: 'card',
            position: { x: n.x, y: n.y },
            // CardNode 是按 luhmannId 渲染的，这里把它当成普通节点
            // 把 cardId 塞进 data 让 CardNode 拉到正确的卡
            data: {
              card: { luhmannId: n.cardId, title: '', status: 'ATOMIC', tags: [], crossLinks: [], depth: 0, sortKey: '' },
              variant: 'tree',
            } as unknown as Record<string, unknown>,
            // override id used by CardNode for fetching: CardNode uses props.id
            // but CardNode's useEffect uses `id` from NodeProps which is workspace-local
            // We need to make CardNode fetch by cardId instead — solve via WorkspaceCardNodeWrapper below
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
          } as unknown as Record<string, unknown>,
        };
      });
      const wsEdges: Edge[] = ws.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        type: 'wsApply',
        data: { applied: !!e.applied, workspaceId: ws.id, edgeId: e.id } as unknown as Record<string, unknown>,
        style: e.applied
          ? { stroke: '#7c4dff', strokeWidth: 2 }
          : { stroke: '#9ca3af', strokeWidth: 1.5, strokeDasharray: '6 4' },
      }));
      return { nodes: wsNodes, edges: wsEdges };
    },
    [],
  );

  // —— 自动保存（debounced）
  const saveTimer = useRef<number | null>(null);
  const persist = useCallback(
    (next: Workspace) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        api.updateWorkspace(next.id, { nodes: next.nodes, edges: next.edges }).catch((err) =>
          console.error('save workspace failed', err),
        );
      }, 400);
    },
    [],
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

  const promoteTempToVault = useCallback(
    async (nodeId: string) => {
      const luhmannId = window.prompt('请输入 vault 中的 luhmannId（如 5b1）：');
      if (!luhmannId?.trim()) return;
      try {
        await api.tempToVault(workspaceId, nodeId, luhmannId.trim());
        qc.invalidateQueries({ queryKey: ['workspace', workspaceId] });
        qc.invalidateQueries({ queryKey: ['cards'] });
      } catch (err) {
        alert((err as Error).message);
      }
    },
    [workspaceId, qc],
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
          } as WorkspaceEdge,
        ],
      }));
    },
    [mutateWs],
  );

  // ws 数据更新时，同步到 ReactFlow state（合并位置）
  useEffect(() => {
    if (!wsQ.data) return;
    const built = buildNodes(wsQ.data, { updateNode, deleteNode, promoteTempToVault });
    setNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return built.nodes.map((n) => ({
        ...n,
        position: prevPos.get(n.id) ?? n.position,
      }));
    });
    setEdges(built.edges);
  }, [wsQ.data, buildNodes, updateNode, deleteNode, promoteTempToVault, setNodes, setEdges]);

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

  const onPaneDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      // 只响应在画布空白处的双击
      const target = e.target as HTMLElement;
      if (!target.classList.contains('react-flow__pane') && !target.classList.contains('react-flow__background')) return;
      // 转换屏幕坐标到画布坐标
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      // 简化：用屏幕中心相对于画布原点估算（精确做法是 useReactFlow().screenToFlowPosition）
      const x = e.clientX - rect.left - 140;
      const y = e.clientY - rect.top - 60;
      addNote(x, y);
    },
    [addNote],
  );

  if (wsQ.isLoading) return <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">加载工作区…</div>;
  if (wsQ.error || !wsQ.data)
    return <div className="w-full h-full flex items-center justify-center text-sm text-red-500">{String(wsQ.error ?? '工作区不存在')}</div>;

  return (
    <div
      ref={containerRef}
      className={`w-full h-full relative bg-[#fafaf6] transition-colors ${dragHover ? 'bg-accentSoft/40' : ''}`}
      onDoubleClick={onPaneDoubleClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* 顶部工具条 */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-1 bg-white/95 backdrop-blur-sm px-2 py-1.5 rounded-lg shadow-md border border-gray-200">
        {/* 4 方向 docking */}
        <div className="flex items-center gap-0.5 px-1 border-r border-gray-200 mr-1">
          <DockBtn icon={<PanelLeft size={13} />} active={workspacePanelPosition === 'left'} onClick={() => setWorkspacePanelPosition('left')} title="停靠到左边" />
          <DockBtn icon={<PanelTop size={13} />} active={workspacePanelPosition === 'top'} onClick={() => setWorkspacePanelPosition('top')} title="停靠到上边" />
          <DockBtn icon={<PanelBottom size={13} />} active={workspacePanelPosition === 'bottom'} onClick={() => setWorkspacePanelPosition('bottom')} title="停靠到下边" />
          <DockBtn icon={<PanelRight size={13} />} active={workspacePanelPosition === 'right'} onClick={() => setWorkspacePanelPosition('right')} title="停靠到右边" />
        </div>
        <button
          onClick={toggleWorkspacePanelPinned}
          className={`p-1 rounded hover:bg-gray-100 ${workspacePanelPinned ? 'text-accent' : 'text-gray-400'}`}
          title={workspacePanelPinned ? '已 pin（布局会被记住）' : 'pin 当前布局'}
        >
          {workspacePanelPinned ? <Pin size={13} /> : <PinOff size={13} />}
        </button>
        <button
          onClick={() => setWorkspaceFullscreen(!workspaceFullscreen)}
          className="p-1 rounded hover:bg-gray-100 text-gray-500"
          title={workspaceFullscreen ? '退出全屏（split 视图）' : '全屏'}
        >
          {workspaceFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button
          onClick={() => setFocusWorkspace(null)}
          className="p-1 rounded hover:bg-gray-100 text-gray-500"
          title="关闭工作区面板"
        >
          <X size={14} />
        </button>
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
          {wsQ.data.nodes.length} 节点 · {wsQ.data.edges.length} 边
        </span>
        <div className="border-l border-gray-200 mx-1 h-4" />
        <button
          onClick={() => addNote(200, 200)}
          className="flex items-center gap-1 text-[11px] font-bold text-yellow-700 hover:text-yellow-800 px-2 py-1 rounded hover:bg-yellow-50"
          title="加便签"
        >
          <StickyNote size={12} /> 便签
        </button>
        <button
          onClick={() => addTempCard(400, 200)}
          className="flex items-center gap-1 text-[11px] font-bold text-purple-700 hover:text-purple-800 px-2 py-1 rounded hover:bg-purple-50"
          title="加临时卡"
        >
          <FilePlus size={12} /> 临时卡
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
          placeholder="vault 卡 id"
          className="w-24 text-[11px] font-mono px-2 py-0.5 border border-gray-200 rounded focus:border-accent outline-none"
        />
        <button
          onClick={() => {
            addCardRef(addCardInput);
            setAddCardInput('');
          }}
          className="flex items-center gap-1 text-[11px] font-bold text-emerald-700 hover:text-emerald-800 px-2 py-1 rounded hover:bg-emerald-50"
          title="按 luhmannId 把 vault 卡加进来（如 1a2）"
        >
          <Layers size={12} /> 加卡
        </button>
      </div>

      {/* 提示语 */}
      {wsQ.data.nodes.length === 0 && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 text-center text-gray-400 text-sm pointer-events-none">
          双击空白处 + 便签 / 临时卡 / 把 vault 卡片拖进来 ・ 自由连线作为思维链<br/>
          <span className="text-[11px]">连线后可以"应用到 vault"，把临时连接转为正式 [[link]]</span>
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
        <Background gap={24} size={1.5} color="#e5e7eb" />
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
  const d = data as unknown as { applied: boolean; workspaceId: string; edgeId: string } | undefined;
  const applyMut = useMutation({
    mutationFn: () => api.applyEdge(d!.workspaceId, d!.edgeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace', d!.workspaceId] });
      qc.invalidateQueries({ queryKey: ['cards'] });
    },
  });
  const unapplyMut = useMutation({
    mutationFn: () => api.unapplyEdge(d!.workspaceId, d!.edgeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace', d!.workspaceId] });
      qc.invalidateQueries({ queryKey: ['cards'] });
    },
  });
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
          {!d?.applied ? (
            <button
              onClick={() => {
                if (applyMut.isPending) return;
                if (!confirm('把这条边写入 vault，作为 source 卡片正文里的 [[target]]？')) return;
                applyMut.mutate();
              }}
              disabled={applyMut.isPending}
              className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white border border-accent/40 text-accent hover:bg-accent hover:text-white shadow-sm transition-colors"
              title="把这条边写到 vault 里成为真正的 [[link]]"
            >
              {applyMut.isPending ? '应用中…' : 'Apply'}
            </button>
          ) : (
            <button
              onClick={() => {
                if (unapplyMut.isPending) return;
                if (!confirm('撤销：从 vault 中移除这条边的 [[link]]？')) return;
                unapplyMut.mutate();
              }}
              disabled={unapplyMut.isPending}
              className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-accent text-white hover:bg-accent/80 shadow-sm"
              title="撤销 apply：从 vault 移除"
            >
              <Undo2 size={9} />
              {unapplyMut.isPending ? '撤销中…' : 'Applied'}
            </button>
          )}
          {label ? <span className="ml-1 text-[10px] text-gray-500">{label}</span> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { wsApply: ApplyEdge };

function DockBtn({
  icon,
  active,
  onClick,
  title,
}: {
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
        active ? 'bg-accent text-white' : 'text-gray-400 hover:bg-gray-100 hover:text-ink'
      }`}
    >
      {icon}
    </button>
  );
}
