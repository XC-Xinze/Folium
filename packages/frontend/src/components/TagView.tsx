import { useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from '@xyflow/react';
import { Tag } from 'lucide-react';
import { api, type PositionMap } from '../lib/api';
import { useUIStore } from '../store/uiStore';
import { CardNode } from './CardNode';
import { TagRootNode } from './TagRootNode';
import { applyAnchorPositions, buildTagGraph } from '../lib/cardGraph';

const nodeTypes = { card: CardNode, 'tag-root': TagRootNode };

interface Props {
  tag: string;
}

export function TagView(props: Props) {
  return (
    <ReactFlowProvider>
      <TagViewInner {...props} />
    </ReactFlowProvider>
  );
}

function TagViewInner({ tag }: Props) {
  // pane 模式下"返回"没意义 —— 关 tab 即可。把按钮藏起来，免得困惑用户。
  void useUIStore;
  const q = useQuery({ queryKey: ['tag-cards', tag], queryFn: () => api.getCardsByTag(tag) });

  const scope = `tag:${tag}`;
  const positionsQ = useQuery({
    queryKey: ['positions', scope],
    queryFn: () => api.getPositions(scope),
  });

  const graph = useMemo(() => {
    if (!q.data?.cards) return { nodes: [] as Node[], edges: [] as Edge[] };
    const raw = buildTagGraph(tag, q.data.cards);
    const finalNodes = applyAnchorPositions(raw.nodes, raw.edges, positionsQ.data ?? {});
    // 把 scope 印到节点 data 上 —— CardNode 用它做位置存储 key
    const stamped = finalNodes.map((n) => ({
      ...n,
      data: { ...(n.data as object), scope },
    }));
    return { nodes: stamped, edges: raw.edges };
  }, [tag, q.data, positionsQ.data, scope]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    setNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return graph.nodes.map((n) => {
        const cached = prevPos.get(n.id);
        return cached ? { ...n, position: cached } : n;
      });
    });
    setEdges(graph.edges);
  }, [graph, setNodes, setEdges]);

  const qc = useQueryClient();
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

  return (
    <div className="w-full h-full relative bg-[#fafafa]">
      {/* Top chip — 关闭走 tab 的 X */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-3 bg-white px-3 py-1.5 rounded-lg shadow-md border border-gray-200">
        <div className="flex items-center gap-1.5 px-2 py-0.5 bg-accentSoft rounded-full">
          <Tag size={11} className="text-accent" />
          <span className="text-[12px] font-bold text-accent">#{tag}</span>
        </div>
        <span className="text-[11px] text-gray-500">{q.data?.cards.length ?? 0} cards</span>
      </div>

      {q.isLoading && (
        <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
          Loading…
        </div>
      )}
      {q.error && (
        <div className="w-full h-full flex items-center justify-center text-sm text-red-500">
          {String(q.error)}
        </div>
      )}
      {q.data && q.data.cards.length === 0 && (
        <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
          No cards under this tag yet
        </div>
      )}

      {q.data && q.data.cards.length > 0 && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 1, minZoom: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background id={`tag-bg-${tag}`} gap={24} size={1.5} color="#e5e7eb" />
          <Controls position="bottom-right" showInteractive={false} />
          <MiniMap pannable zoomable position="top-right" maskColor="rgba(0,0,0,0.05)" />
        </ReactFlow>
      )}
    </div>
  );
}
