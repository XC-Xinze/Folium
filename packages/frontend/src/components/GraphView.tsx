import { useMemo } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useViewport,
  type Edge,
  type Node,
} from '@xyflow/react';
import dagre from 'dagre';
import { useQuery } from '@tanstack/react-query';
import { api, type CardSummary } from '../lib/api';
import { useNavigateToCard } from '../lib/useNavigateToCard';

/**
 * 全局 Graph 视图：vault 里所有卡片的概览。
 *   - 缩放小：节点是小圆点，只显示 luhmannId
 *   - 缩放中：显示标题
 *   - 缩放大：显示标题 + tag 列表
 *   - 双击节点 → 切回 chain 视图聚焦
 */

interface GraphNodeData {
  card: CardSummary;
  isIndex: boolean;
}

const NODE_W = 180;
const NODE_H = 60;

function buildGlobalGraph(cards: CardSummary[]): { nodes: Node[]; edges: Edge[] } {
  if (cards.length === 0) return { nodes: [], edges: [] };

  // ── 1. 构建 dagre 图，按 luhmann 父子关系拉树 ──
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 30, ranksep: 60, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  const cardSet = new Set(cards.map((c) => c.luhmannId));

  for (const c of cards) {
    g.setNode(c.luhmannId, { width: NODE_W, height: NODE_H });
  }

  // ── 2. tree 边：parent 派生于 luhmannId 编号尾去一层 ──
  const treeEdges: Edge[] = [];
  for (const c of cards) {
    const parent = parentOf(c.luhmannId);
    if (parent && cardSet.has(parent)) {
      g.setEdge(parent, c.luhmannId);
      treeEdges.push({
        id: `tree:${parent}-${c.luhmannId}`,
        source: parent,
        target: c.luhmannId,
        type: 'smoothstep',
        style: { stroke: '#cbd5e1', strokeWidth: 1 },
      });
    }
  }

  dagre.layout(g);

  // ── 3. cross-link 边（叠加，不参与布局） ──
  const crossEdges: Edge[] = [];
  const seen = new Set<string>();
  for (const c of cards) {
    for (const t of c.crossLinks) {
      if (!cardSet.has(t)) continue;
      const key = [c.luhmannId, t].sort().join('->');
      if (seen.has(key)) continue;
      seen.add(key);
      crossEdges.push({
        id: `cross:${c.luhmannId}-${t}`,
        source: c.luhmannId,
        target: t,
        type: 'straight',
        style: { stroke: '#7c4dff', strokeWidth: 0.8, opacity: 0.4 },
      });
    }
  }

  const nodes: Node[] = cards.map((c) => {
    const pos = g.node(c.luhmannId);
    return {
      id: c.luhmannId,
      type: 'graphNode',
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: { card: c, isIndex: c.status === 'INDEX' } satisfies GraphNodeData,
      width: NODE_W,
      height: NODE_H,
    };
  });

  return { nodes, edges: [...treeEdges, ...crossEdges] };
}

function parentOf(id: string): string | null {
  if (!id) return null;
  // luhmann id：交替数字/字母段。剥掉最后一段。
  // 1a2b3 → 1a2b, 1a2 → 1a, 1a → 1, 1 → null
  // 注意 daily20260424 这种"非编号"卡 → 没有 parent
  if (!/^[\da-z]+$/i.test(id)) return null;
  // 如果末尾是数字，剥掉所有连续数字
  if (/\d$/.test(id)) {
    return id.replace(/\d+$/, '') || null;
  }
  // 末尾是字母，剥掉所有连续字母
  if (/[a-z]$/i.test(id)) {
    return id.replace(/[a-z]+$/i, '') || null;
  }
  return null;
}

/**
 * 节点组件：根据当前 zoom 切显示密度
 */
function GraphNode({ data }: { data: GraphNodeData }) {
  const { zoom } = useViewport();
  const { card, isIndex } = data;
  // 缩放分级：< 0.5 = dot, < 1.2 = title, >= 1.2 = full
  const level: 'dot' | 'title' | 'full' = zoom < 0.5 ? 'dot' : zoom < 1.2 ? 'title' : 'full';

  if (level === 'dot') {
    return (
      <div
        className={`rounded-full ${isIndex ? 'bg-accent' : 'bg-gray-400 dark:bg-[#494d64]'}`}
        style={{ width: 16, height: 16, marginLeft: NODE_W / 2 - 8, marginTop: NODE_H / 2 - 8 }}
        title={`${card.luhmannId} · ${card.title}`}
      />
    );
  }

  return (
    <div
      className={`rounded-lg border ${
        isIndex
          ? 'border-accent bg-accent/10'
          : 'border-gray-200 dark:border-[#494d64] bg-white dark:bg-[#363a4f]'
      } px-2 py-1 shadow-sm`}
      style={{ width: NODE_W, minHeight: NODE_H }}
    >
      <div className="flex items-baseline gap-1.5">
        <span
          className={`font-mono text-[9px] font-bold ${
            isIndex ? 'text-accent' : 'text-gray-500 dark:text-[#a5adcb]'
          }`}
        >
          {card.luhmannId}
        </span>
        <span className="text-[11px] truncate text-ink dark:text-[#cad3f5]">
          {card.title || card.luhmannId}
        </span>
      </div>
      {level === 'full' && card.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {card.tags.slice(0, 4).map((t) => (
            <span key={t} className="text-[8px] font-bold text-accent">
              #{t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { graphNode: GraphNode };

function GraphInner() {
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const navigate = useNavigateToCard();
  const { nodes, edges } = useMemo(() => {
    if (!cardsQ.data) return { nodes: [] as Node[], edges: [] as Edge[] };
    return buildGlobalGraph(cardsQ.data.cards);
  }, [cardsQ.data]);

  if (cardsQ.isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
        Loading vault…
      </div>
    );
  }
  if (!cardsQ.data?.cards.length) {
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
        Vault is empty.
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeDoubleClick={(_e, node) => navigate(node.id)}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1.5, minZoom: 0.1 }}
        minZoom={0.05}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
      >
        <Background id="graph-bg" gap={32} size={1} color="#e5e7eb" />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap pannable zoomable position="top-right" maskColor="rgba(0,0,0,0.04)" />
      </ReactFlow>

      <div className="absolute top-4 left-4 z-10 px-3 py-1.5 bg-white/95 dark:bg-[#363a4f]/95 backdrop-blur-sm rounded-full shadow-md border border-gray-200 dark:border-[#494d64]">
        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500 dark:text-[#a5adcb]">
          Vault graph · {cardsQ.data.cards.length} cards · scroll to zoom · double-click to focus
        </span>
      </div>
    </div>
  );
}

export function GraphView() {
  return (
    <ReactFlowProvider>
      <GraphInner />
    </ReactFlowProvider>
  );
}
