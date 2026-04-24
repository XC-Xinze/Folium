import { useCallback, useEffect, useMemo, useRef } from 'react';
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
import { CardNode } from './CardNode';
import { applyAnchorPositions, buildGraph, computeBackbone, resolveCollisions } from '../lib/cardGraph';
import { useUIStore } from '../store/uiStore';

const nodeTypes = { card: CardNode };

interface Props {
  focusedBoxId: string;
  focusedCardId: string;
}

function CanvasInner({ focusedBoxId, focusedCardId }: Props) {
  const showPotential = useUIStore((s) => s.showPotential);
  const setShowPotential = useUIStore((s) => s.setShowPotential);
  const showTagRelated = useUIStore((s) => s.showTagRelated);
  const setShowTagRelated = useUIStore((s) => s.setShowTagRelated);
  const showCrossLinks = useUIStore((s) => s.showCrossLinks);
  const setShowCrossLinks = useUIStore((s) => s.setShowCrossLinks);
  const qc = useQueryClient();

  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  // 同时拿 box 和 focus 的完整内容（box 用于 INDEX 展开 cross-link）
  const boxQ = useQuery({ queryKey: ['card', focusedBoxId], queryFn: () => api.getCard(focusedBoxId) });
  const focusQ = useQuery({
    queryKey: ['card', focusedCardId],
    queryFn: () => api.getCard(focusedCardId),
    enabled: focusedCardId !== focusedBoxId,
  });
  const linkedQ = useQuery({
    queryKey: ['linked', focusedBoxId],
    queryFn: () => api.getLinked(focusedBoxId),
  });

  const fullCards = useMemo(() => {
    const m = new Map<string, Card>();
    if (boxQ.data) m.set(boxQ.data.luhmannId, boxQ.data);
    if (focusQ.data) m.set(focusQ.data.luhmannId, focusQ.data);
    for (const c of linkedQ.data?.linked ?? []) m.set(c.luhmannId, c);
    return m;
  }, [boxQ.data, focusQ.data, linkedQ.data]);

  const backboneIds = useMemo(() => {
    if (!cardsQ.data || !boxQ.data) return [] as string[];
    const bb = computeBackbone(focusedBoxId, cardsQ.data.cards, fullCards);
    return [...bb.ids];
  }, [cardsQ.data, boxQ.data, fullCards, focusedBoxId]);

  // tag-related 是 first-class（默认显示），不受 showPotential 影响——所以总要拉
  const relatedBatchQ = useQuery({
    queryKey: ['related-batch', backboneIds],
    queryFn: () => api.relatedBatch(backboneIds, 3),
    enabled: backboneIds.length > 0,
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
    if (!cardsQ.data || !boxQ.data) return { nodes: [] as Node[], edges: [] as Edge[] };
    const raw = buildGraph({
      allCards: cardsQ.data.cards,
      fullCards,
      focusedBoxId,
      focusedCardId,
      relatedBatch: relatedBatchQ.data ?? {},
      showPotential,
      showTagRelated,
      showCrossLinks,
      workspaceLinks: workspaceLinksQ.data?.links ?? [],
    });
    const anchored = applyAnchorPositions(raw.nodes, raw.edges, positionsQ.data ?? {});
    // 一次性碰撞解算：把自动布局产生的重叠抹掉，但锁定用户手动拖过的位置
    const finalNodes = resolveCollisions(anchored, positionsQ.data ?? {});
    return { nodes: finalNodes, edges: raw.edges };
  }, [
    cardsQ.data,
    boxQ.data,
    fullCards,
    focusedBoxId,
    focusedCardId,
    relatedBatchQ.data,
    showPotential,
    showTagRelated,
    showCrossLinks,
    workspaceLinksQ.data,
    positionsQ.data,
  ]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // 切换 box 时清缓存（避免跨 box 的位置串联）；同 box 内切换焦点时保留位置
  const prevBoxRef = useRef(focusedBoxId);
  useEffect(() => {
    const boxChanged = prevBoxRef.current !== focusedBoxId;
    prevBoxRef.current = focusedBoxId;
    setNodes((prev) => {
      if (boxChanged) {
        // box 变了 → 完全重新布局
        return graph.nodes;
      }
      // 同 box 内：保留 React Flow 现有位置（含本会话拖拽未保存的）
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return graph.nodes.map((n) => {
        const cached = prevPos.get(n.id);
        return cached ? { ...n, position: cached } : n;
      });
    });
    setEdges(graph.edges);
  }, [graph, focusedBoxId, setNodes, setEdges]);

  // 拖拽结束 → 乐观更新 + 异步写磁盘（scope 限定）
  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      if (node.id.startsWith('__')) return;
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
  if (boxQ.isLoading) return <FullCenter>Loading box {focusedBoxId}…</FullCenter>;
  if (boxQ.error) return <FullCenter error>Box {focusedBoxId} not found</FullCenter>;

  return (
    <div className="w-full h-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1, minZoom: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1.5} color="#e5e7eb" />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap pannable zoomable position="top-right" maskColor="rgba(0,0,0,0.05)" />
      </ReactFlow>

      {/* 边类型开关，左上角 */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-1.5 px-2 py-1.5 bg-white/95 backdrop-blur-sm rounded-full shadow-md border border-gray-200">
        <EdgeToggle
          color="#7c4dff"
          label="Link"
          active={showCrossLinks}
          onClick={() => setShowCrossLinks(!showCrossLinks)}
          title="Manual [[link]] edges (purple)"
        />
        <EdgeToggle
          color="#10b981"
          label="Tag"
          active={showTagRelated}
          onClick={() => setShowTagRelated(!showTagRelated)}
          title="Tag co-occurrence edges (green)"
        />
        <EdgeToggle
          color="#cbd5e1"
          label="Potential"
          active={showPotential}
          onClick={() => setShowPotential(!showPotential)}
          title="Text-similarity potential edges (gray dashed)"
        />
      </div>
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
