import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { useQuery } from '@tanstack/react-query';
import { api, type Card, type CardSummary } from '../lib/api';
import { useNavigateToCard } from '../lib/useNavigateToCard';
import { renderMarkdown } from '../lib/markdown';

/**
 * 全局 Vault Graph：
 *   - 力导向布局（d3-force 一次性 settle，不持续跑）
 *   - 单击：选中此卡，把它"box"内的边加粗（box = 包含该卡的 INDEX）
 *   - 双击：以这张卡为焦点开新 tab（chain 视图）
 *   - 缩放分级：dot / 最小 / 中等 / 完整渲染（含 markdown）
 *   - 选中卡始终展开为完整 markdown，不管 zoom
 */

const NODE_W = 220;
const NODE_H = 120;

interface GraphNodeData {
  card: CardSummary;
  isIndex: boolean;
  isSelected: boolean;
  // zoom 不放进 data —— 节点自己用 useViewport 读，避免每次 zoom 重建 nodes 数组
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  isIndex: boolean;
}
interface SimLink {
  source: string;
  target: string;
  kind: 'tree' | 'cross';
}

function parentOf(id: string): string | null {
  if (!id || !/^[\da-z]+$/i.test(id)) return null;
  if (/\d$/.test(id)) return id.replace(/\d+$/, '') || null;
  if (/[a-z]$/i.test(id)) return id.replace(/[a-z]+$/i, '') || null;
  return null;
}

/** 推导每张卡所属的 box 集合（哪些 INDEX 引用了它，或它自己是 INDEX → 算自己的 box） */
function computeBoxMembership(cards: CardSummary[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const ensure = (id: string) => {
    if (!result.has(id)) result.set(id, new Set());
    return result.get(id)!;
  };
  for (const c of cards) {
    if (c.status === 'INDEX') {
      ensure(c.luhmannId).add(c.luhmannId); // INDEX 算自己的 box
      for (const t of c.crossLinks) ensure(t).add(c.luhmannId);
    }
  }
  // 沿 Folgezettel 父链继承 box（子卡跟父卡共享 box）
  for (const c of cards) {
    let cur = c.luhmannId;
    while (true) {
      const p = parentOf(cur);
      if (!p) break;
      const parentBoxes = result.get(p);
      if (parentBoxes) for (const b of parentBoxes) ensure(c.luhmannId).add(b);
      cur = p;
    }
  }
  return result;
}

/** 跑一次 d3-force 拿稳定布局 */
function runSimulation(
  cards: CardSummary[],
): { positions: Map<string, { x: number; y: number }>; links: SimLink[] } {
  const cardSet = new Set(cards.map((c) => c.luhmannId));
  const nodes: SimNode[] = cards.map((c) => ({
    id: c.luhmannId,
    isIndex: c.status === 'INDEX',
  }));
  const links: SimLink[] = [];
  const seen = new Set<string>();

  // tree 边（强）
  for (const c of cards) {
    const p = parentOf(c.luhmannId);
    if (p && cardSet.has(p)) {
      const k = `tree:${p}->${c.luhmannId}`;
      if (!seen.has(k)) {
        seen.add(k);
        links.push({ source: p, target: c.luhmannId, kind: 'tree' });
      }
    }
  }
  // INDEX → 引用的卡（更强 —— 把 box 内的卡聚拢）
  for (const c of cards) {
    if (c.status !== 'INDEX') continue;
    for (const t of c.crossLinks) {
      if (!cardSet.has(t)) continue;
      const k = `idx:${c.luhmannId}->${t}`;
      if (!seen.has(k)) {
        seen.add(k);
        links.push({ source: c.luhmannId, target: t, kind: 'tree' });
      }
    }
  }
  // cross 边（弱，影响小）
  for (const c of cards) {
    if (c.status === 'INDEX') continue;
    for (const t of c.crossLinks) {
      if (!cardSet.has(t)) continue;
      const k = [c.luhmannId, t].sort().join('--');
      if (seen.has(k)) continue;
      seen.add(k);
      links.push({ source: c.luhmannId, target: t, kind: 'cross' });
    }
  }

  const sim = forceSimulation(nodes)
    .force(
      'link',
      forceLink<SimNode, SimLink & { source: string | SimNode; target: string | SimNode }>(
        links as never,
      )
        .id((n) => (n as SimNode).id)
        .distance((l) => ((l as SimLink).kind === 'tree' ? 180 : 320))
        .strength((l) => ((l as SimLink).kind === 'tree' ? 0.7 : 0.1)),
    )
    .force('charge', forceManyBody<SimNode>().strength((n) => (n.isIndex ? -1500 : -500)))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide<SimNode>(NODE_W * 0.7))
    .stop();

  // 跑足够 ticks 让布局 settle —— 力越强需要的 ticks 越多
  const TICKS = 400;
  for (let i = 0; i < TICKS; i++) sim.tick();

  const positions = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    positions.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
  }
  return { positions, links };
}

const nodeTypes = { graphNode: GraphNode };

function GraphInner() {
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const navigate = useNavigateToCard();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { positions, links, boxes } = useMemo(() => {
    if (!cardsQ.data) {
      return {
        positions: new Map<string, { x: number; y: number }>(),
        links: [] as SimLink[],
        boxes: new Map<string, Set<string>>(),
      };
    }
    const sim = runSimulation(cardsQ.data.cards);
    const boxes = computeBoxMembership(cardsQ.data.cards);
    return { positions: sim.positions, links: sim.links, boxes };
  }, [cardsQ.data]);

  // 选中卡的 box 集合 —— 同 box 内任意两点的边加粗
  const selectedBoxes: Set<string> = selectedId
    ? boxes.get(selectedId) ?? new Set<string>()
    : new Set<string>();

  // nodes 数组只在卡片列表 / positions / selectedId 变时重建。
  // 不再依赖 viewport.zoom —— GraphNode 自己读 zoom，避免每次 zoom 整个数组重建。
  const nodes: Node[] = useMemo(() => {
    if (!cardsQ.data) return [];
    return cardsQ.data.cards.map((c) => {
      const pos = positions.get(c.luhmannId) ?? { x: 0, y: 0 };
      return {
        id: c.luhmannId,
        type: 'graphNode',
        position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
        data: {
          card: c,
          isIndex: c.status === 'INDEX',
          isSelected: selectedId === c.luhmannId,
        } satisfies GraphNodeData,
        width: NODE_W,
        height: NODE_H,
      };
    });
  }, [cardsQ.data, positions, selectedId]);

  const edges: Edge[] = useMemo(() => {
    return links.map((l) => {
      const sourceBoxes = boxes.get(l.source) ?? new Set<string>();
      const targetBoxes = boxes.get(l.target) ?? new Set<string>();
      // 是否在选中卡的 box 内（source 和 target 都在 selectedBoxes 中的某个 box）
      const inSelectedBox = selectedId
        ? [...selectedBoxes].some((b) => sourceBoxes.has(b) && targetBoxes.has(b))
        : false;
      const isCross = l.kind === 'cross';
      return {
        id: `${l.kind}:${l.source}->${l.target}`,
        source: l.source,
        target: l.target,
        type: 'simplebezier', // 比 straight 更"力导向"的曲线感
        style: {
          stroke: inSelectedBox
            ? isCross
              ? '#7c4dff'
              : '#1f2937'
            : isCross
              ? '#7c4dff'
              : '#cbd5e1',
          strokeWidth: inSelectedBox ? 2.4 : isCross ? 0.8 : 1,
          opacity: selectedId
            ? inSelectedBox
              ? 1
              : 0.12
            : isCross
              ? 0.4
              : 0.7,
        },
      };
    });
  }, [links, boxes, selectedId, selectedBoxes]);

  if (cardsQ.isLoading)
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
        Loading vault…
      </div>
    );
  if (!cardsQ.data?.cards.length)
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
        Vault is empty.
      </div>
    );

  return (
    <div className="w-full h-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(e, node) => {
          e.stopPropagation();
          setSelectedId((cur) => (cur === node.id ? null : node.id));
        }}
        onNodeDoubleClick={(_e, node) => navigate(node.id)}
        onPaneClick={() => setSelectedId(null)}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1.2, minZoom: 0.1 }}
        minZoom={0.05}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
      >
        <Background id="graph-bg" gap={32} size={1} color="#e5e7eb" />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap pannable zoomable position="top-right" maskColor="rgba(0,0,0,0.04)" />
      </ReactFlow>

      <div className="absolute top-4 left-4 z-10 px-3 py-1.5 bg-white/95 dark:bg-[#363a4f]/95 backdrop-blur-sm rounded-full shadow-md border border-gray-200 dark:border-[#494d64]">
        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500 dark:text-[#a5adcb]">
          Vault graph · {cardsQ.data.cards.length} cards · single-click = focus + show content · double-click = open
        </span>
      </div>
    </div>
  );
}

/** 单节点：根据 zoom + selected 切渲染密度 */
function GraphNode({ data }: { data: GraphNodeData }) {
  const { card, isIndex, isSelected } = data;
  // 在节点内部读 zoom：每张卡只在自己 level 跨阈值时 re-render，
  // 不会因为 zoom 微变就整个数组重建
  const { zoom } = useViewport();
  // 缩放分级：
  //   选中卡始终 full（一键看 markdown，不用使劲缩放）
  //   非选中：低 zoom dot/mini/normal，zoom >= 1.5 才 full（避免 28 张卡同时拉 markdown）
  const level: 'dot' | 'mini' | 'normal' | 'full' = isSelected
    ? 'full'
    : zoom >= 1.5
      ? 'full'
      : zoom < 0.3
        ? 'dot'
        : zoom < 0.7
          ? 'mini'
          : 'normal';

  if (level === 'dot') {
    return (
      <div
        className={`rounded-full transition-colors ${
          isIndex ? 'bg-accent' : 'bg-gray-400 dark:bg-[#6e738d]'
        } ${isSelected ? 'ring-2 ring-accent ring-offset-2' : ''}`}
        style={{
          width: isIndex ? 14 : 8,
          height: isIndex ? 14 : 8,
          marginLeft: NODE_W / 2 - (isIndex ? 7 : 4),
          marginTop: NODE_H / 2 - (isIndex ? 7 : 4),
        }}
        title={`${card.luhmannId} · ${card.title}`}
      />
    );
  }

  if (level === 'mini') {
    return (
      <div
        className={`rounded-md border ${
          isSelected
            ? 'border-accent ring-2 ring-accent/30'
            : isIndex
              ? 'border-accent bg-accent/10'
              : 'border-gray-200 dark:border-[#494d64] bg-white dark:bg-[#363a4f]'
        } px-2 py-1`}
        style={{ width: NODE_W }}
      >
        <span className={`font-mono text-[10px] font-bold ${isIndex ? 'text-accent' : 'text-gray-500 dark:text-[#a5adcb]'}`}>
          {card.luhmannId}
        </span>
      </div>
    );
  }

  if (level === 'normal') {
    return (
      <div
        className={`rounded-lg border ${
          isSelected
            ? 'border-accent border-2 ring-2 ring-accent/30 bg-white dark:bg-[#363a4f]'
            : isIndex
              ? 'border-accent bg-accent/10'
              : 'border-gray-200 dark:border-[#494d64] bg-white dark:bg-[#363a4f]'
        } px-2 py-1.5 shadow-sm`}
        style={{ width: NODE_W }}
      >
        <div className="flex items-baseline gap-1.5">
          <span className={`font-mono text-[10px] font-bold ${isIndex ? 'text-accent' : 'text-gray-500 dark:text-[#a5adcb]'}`}>
            {card.luhmannId}
          </span>
          <span className="text-[11px] truncate text-ink dark:text-[#cad3f5]">
            {card.title || card.luhmannId}
          </span>
        </div>
        {card.tags.length > 0 && (
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

  // 'full' —— 选中或大缩放，渲染完整 markdown
  return <FullCardNode card={card} isIndex={isIndex} isSelected={isSelected} />;
}

/** 完整卡片节点：拉 contentMd，渲 markdown */
function FullCardNode({
  card,
  isIndex,
  isSelected,
}: {
  card: CardSummary;
  isIndex: boolean;
  isSelected: boolean;
}) {
  const fullQ = useQuery({
    queryKey: ['card', card.luhmannId],
    queryFn: () => api.getCard(card.luhmannId),
  });
  const html = useMemo(
    () => (fullQ.data ? renderMarkdown(fullQ.data.contentMd) : ''),
    [fullQ.data?.contentMd],
  );
  const ref = useRef<HTMLDivElement>(null);
  // 用 fullCard 的尺寸覆盖默认 NODE_W/H
  return (
    <div
      ref={ref}
      className={`rounded-xl border shadow-md ${
        isSelected
          ? 'border-accent border-2 ring-2 ring-accent/30'
          : isIndex
            ? 'border-accent'
            : 'border-gray-200 dark:border-[#494d64]'
      } bg-white dark:bg-[#363a4f] p-3 overflow-hidden`}
      style={{ width: 360, maxHeight: 380 }}
    >
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className={`font-mono text-[10px] font-bold ${isIndex ? 'text-accent' : 'text-gray-500 dark:text-[#a5adcb]'}`}>
          {card.luhmannId}
        </span>
        <span className="text-[12px] font-bold truncate text-ink dark:text-[#cad3f5]">
          {card.title || card.luhmannId}
        </span>
      </div>
      <div
        className="prose-card text-[11px] text-ink dark:text-[#cad3f5] overflow-y-auto"
        style={{ maxHeight: 320 }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {card.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-gray-100 dark:border-[#494d64]">
          {card.tags.slice(0, 8).map((t) => (
            <span key={t} className="text-[9px] font-bold text-accent">
              #{t}
            </span>
          ))}
        </div>
      )}
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
