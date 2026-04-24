import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
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
  type Simulation,
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
type LinkKind = 'hierarchy' | 'link' | 'tag' | 'box';
interface SimLink {
  source: string;
  target: string;
  kind: LinkKind;
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

/** 给定卡片，构建 sim 节点 + 链接（不跑 sim） */
function buildSimGraph(cards: CardSummary[]): { simNodes: SimNode[]; links: SimLink[] } {
  const cardSet = new Set(cards.map((c) => c.luhmannId));
  const simNodes: SimNode[] = cards.map((c) => ({
    id: c.luhmannId,
    isIndex: c.status === 'INDEX',
  }));
  const links: SimLink[] = [];
  const seen = new Set<string>();
  void cardSet;

  // hierarchy 边（强，决定布局 —— Folgezettel 父子 + INDEX→member）
  for (const c of cards) {
    const p = parentOf(c.luhmannId);
    if (p && cardSet.has(p)) {
      const k = `h:${p}->${c.luhmannId}`;
      if (!seen.has(k)) {
        seen.add(k);
        links.push({ source: p, target: c.luhmannId, kind: 'hierarchy' });
      }
    }
  }
  for (const c of cards) {
    if (c.status !== 'INDEX') continue;
    for (const t of c.crossLinks) {
      if (!cardSet.has(t)) continue;
      const k = `h:${c.luhmannId}->${t}`;
      if (!seen.has(k)) {
        seen.add(k);
        links.push({ source: c.luhmannId, target: t, kind: 'hierarchy' });
      }
    }
  }
  // link 边（手动 [[link]]，弱布局影响）
  for (const c of cards) {
    if (c.status === 'INDEX') continue;
    for (const t of c.crossLinks) {
      if (!cardSet.has(t)) continue;
      const k = [c.luhmannId, t].sort().join('|link');
      if (seen.has(k)) continue;
      seen.add(k);
      links.push({ source: c.luhmannId, target: t, kind: 'link' });
    }
  }
  // tag 边：每对卡若有共享 tag → 一条 tag 边（去重）
  // 用倒排索引避免 O(n²)：每个 tag 下的卡两两连
  const tagToCards = new Map<string, string[]>();
  for (const c of cards) {
    for (const t of c.tags) {
      if (!tagToCards.has(t)) tagToCards.set(t, []);
      tagToCards.get(t)!.push(c.luhmannId);
    }
  }
  for (const [tag, ids] of tagToCards) {
    // 跳过过于宽泛的 tag（>20 张卡）—— 否则会画一大片密网
    if (ids.length > 20) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = [ids[i]!, ids[j]!].sort().join('|tag');
        if (seen.has(k)) continue;
        seen.add(k);
        links.push({ source: ids[i]!, target: ids[j]!, kind: 'tag' });
      }
    }
    void tag;
  }
  // box 边：同一 INDEX 引用的成员之间互连（兄弟）
  for (const c of cards) {
    if (c.status !== 'INDEX') continue;
    const members = c.crossLinks.filter((t) => cardSet.has(t));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const k = [members[i]!, members[j]!].sort().join('|box');
        if (seen.has(k)) continue;
        seen.add(k);
        links.push({ source: members[i]!, target: members[j]!, kind: 'box' });
      }
    }
  }

  return { simNodes, links };
}

/** 工厂：建一个 d3-force 模拟实例（不自动 tick，调用方控制） */
function makeSimulation(simNodes: SimNode[], links: SimLink[]): Simulation<SimNode, SimLink> {
  const linkDistance = (k: LinkKind) =>
    k === 'hierarchy' ? 140 : k === 'box' ? 200 : 280;
  const linkStrength = (k: LinkKind) =>
    k === 'hierarchy' ? 0.9 : k === 'box' ? 0.2 : 0.05;

  const sim = forceSimulation(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimLink & { source: string | SimNode; target: string | SimNode }>(
        links as never,
      )
        .id((n) => (n as SimNode).id)
        .distance((l) => linkDistance((l as SimLink).kind))
        .strength((l) => linkStrength((l as SimLink).kind)),
    )
    .force('charge', forceManyBody<SimNode>().strength((n) => (n.isIndex ? -1200 : -300)))
    // 把节点拉向中心 —— Obsidian 的"向心力"，让整张图聚合而不是无限漂
    .force('center', forceCenter(0, 0).strength(0.05))
    .force('collide', forceCollide<SimNode>(NODE_W * 0.45))
    .alphaDecay(0.03); // 默认 0.0228，提高 → 更快 settle，更省 CPU
  return sim as unknown as Simulation<SimNode, SimLink>;
}

const nodeTypes = { graphNode: GraphNode };

interface EdgeToggles {
  hierarchy: boolean;
  link: boolean;
  tag: boolean;
  box: boolean;
}
const DEFAULT_TOGGLES: EdgeToggles = {
  hierarchy: true,
  link: true,
  tag: false, // 默认关，避免一打开 graph 满屏密网
  box: false,
};

function GraphInner() {
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const navigate = useNavigateToCard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [toggles, setToggles] = useState<EdgeToggles>(DEFAULT_TOGGLES);
  const flip = (k: keyof EdgeToggles) => setToggles((s) => ({ ...s, [k]: !s[k] }));

  // 连续力模拟：sim 实例存 ref，每 tick 把 positions 拷到 React state 触发 re-render。
  // 用户拖节点 → 把该节点 fx/fy 钉死，sim 继续跑让其他节点适应；松开 → 清 fx/fy 让物理接管。
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simNodesRef = useRef<Map<string, SimNode>>(new Map());
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [links, setLinks] = useState<SimLink[]>([]);
  const boxes = useMemo(
    () => (cardsQ.data ? computeBoxMembership(cardsQ.data.cards) : new Map<string, Set<string>>()),
    [cardsQ.data],
  );

  // 卡片列表变 → 重建 sim
  useEffect(() => {
    if (!cardsQ.data) return;
    const { simNodes, links: newLinks } = buildSimGraph(cardsQ.data.cards);
    const map = new Map<string, SimNode>();
    for (const n of simNodes) map.set(n.id, n);
    simNodesRef.current = map;
    // 重要：d3-force 会就地把每个 link 的 source/target 替换成 SimNode 对象引用，
    // 我们存进 React state 的副本必须独立，否则 edges useMemo 拿到的 source/target
    // 不再是 id 字符串，React Flow 找不到节点 → 边全消失。
    const linksForReact: SimLink[] = newLinks.map((l) => ({ ...l }));
    const sim = makeSimulation(simNodes, newLinks);
    setLinks(linksForReact);

    let frame = 0;
    sim.on('tick', () => {
      // 节流：每 2 帧推一次到 React，避免 60fps 重渲压垮
      frame++;
      if (frame % 2 !== 0 && sim.alpha() > 0.05) return;
      const next = new Map<string, { x: number; y: number }>();
      for (const n of simNodes) next.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
      setPositions(next);
    });

    simRef.current = sim;
    return () => {
      sim.stop();
      simRef.current = null;
    };
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
    const colorByKind: Record<LinkKind, string> = {
      hierarchy: '#475569', // 深灰，比 #94a3b8 看得清
      link: '#7c4dff', // 紫
      tag: '#10b981', // 绿
      box: '#f59e0b', // 橙
    };
    return links
      .filter((l) => toggles[l.kind])
      .map((l) => {
        const sourceBoxes = boxes.get(l.source) ?? new Set<string>();
        const targetBoxes = boxes.get(l.target) ?? new Set<string>();
        const inSelectedBox = selectedId
          ? [...selectedBoxes].some((b) => sourceBoxes.has(b) && targetBoxes.has(b))
          : false;
        const touchesHovered = hoveredId
          ? l.source === hoveredId || l.target === hoveredId
          : false;
        const baseColor = colorByKind[l.kind];
        // 优先级：hover > selected box > 默认
        const opacity = hoveredId
          ? touchesHovered
            ? 1
            : 0.08
          : selectedId
            ? inSelectedBox
              ? 1
              : 0.1
            : l.kind === 'hierarchy'
              ? 0.85
              : 0.55;
        const strokeWidth = touchesHovered || inSelectedBox ? 2.5 : l.kind === 'hierarchy' ? 1.4 : 1;
        return {
          id: `${l.kind}:${l.source}->${l.target}`,
          source: l.source,
          target: l.target,
          type: 'straight',
          sourceHandle: 's',
          targetHandle: 't',
          style: {
            stroke: baseColor,
            strokeWidth,
            opacity,
            strokeDasharray: l.kind === 'box' ? '4 3' : undefined,
            transition: 'opacity 120ms, stroke-width 120ms',
          },
        };
      });
  }, [links, boxes, selectedId, selectedBoxes, toggles, hoveredId]);

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
        onNodeMouseEnter={(_e, node) => setHoveredId(node.id)}
        onNodeMouseLeave={() => setHoveredId(null)}
        onNodeDragStart={(_e, node) => {
          // 钉死该节点位置 + 加热模拟（让相邻节点重新平衡）
          const sn = simNodesRef.current.get(node.id);
          if (sn) {
            sn.fx = node.position.x + NODE_W / 2;
            sn.fy = node.position.y + NODE_H / 2;
          }
          simRef.current?.alphaTarget(0.3).restart();
        }}
        onNodeDrag={(_e, node) => {
          const sn = simNodesRef.current.get(node.id);
          if (sn) {
            sn.fx = node.position.x + NODE_W / 2;
            sn.fy = node.position.y + NODE_H / 2;
          }
        }}
        onNodeDragStop={(_e, node) => {
          // 释放固定 → 物理接管，过几秒衰减回静止
          const sn = simNodesRef.current.get(node.id);
          if (sn) {
            sn.fx = null;
            sn.fy = null;
          }
          simRef.current?.alphaTarget(0);
        }}
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

      <div className="absolute top-4 left-4 z-10 flex items-center gap-1.5 px-2 py-1.5 bg-white/95 dark:bg-[#363a4f]/95 backdrop-blur-sm rounded-full shadow-md border border-gray-200 dark:border-[#494d64]">
        <EdgeToggle color="#94a3b8" label="Hierarchy" active={toggles.hierarchy} onClick={() => flip('hierarchy')} />
        <EdgeToggle color="#7c4dff" label="Link" active={toggles.link} onClick={() => flip('link')} />
        <EdgeToggle color="#10b981" label="Tag" active={toggles.tag} onClick={() => flip('tag')} />
        <EdgeToggle color="#f59e0b" label="Box" active={toggles.box} onClick={() => flip('box')} />
        <span className="ml-1 text-[10px] text-gray-400 dark:text-[#a5adcb]">
          {cardsQ.data.cards.length} cards
        </span>
      </div>
    </div>
  );
}

function EdgeToggle({
  color,
  label,
  active,
  onClick,
}: {
  color: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest transition-all ${
        active ? 'text-gray-700 dark:text-[#cad3f5]' : 'text-gray-300 dark:text-gray-600'
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

/** 隐形 handles —— 节点中心一个，配合 'straight' edge type 让边像 Obsidian 那样
 *  从节点四面八方"指向"另一节点的中心方向 —— 不再都从 top 发出 */
function Anchors() {
  const handleStyle = {
    opacity: 0,
    pointerEvents: 'none' as const,
    width: 1,
    height: 1,
    minWidth: 0,
    minHeight: 0,
    border: 0,
    background: 'transparent',
  };
  // 同一个 position（Top）但 source 和 target —— React Flow 用直线连接两个 Top
  // 改用 4 方向的 handles，并通过 edge type='straight' 让 React Flow 自己选最近的
  return (
    <>
      <Handle type="source" position={Position.Top} id="s" style={{ ...handleStyle, top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }} />
      <Handle type="target" position={Position.Top} id="t" style={{ ...handleStyle, top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }} />
    </>
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
      <>
        <Anchors />
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
      </>
    );
  }

  if (level === 'mini') {
    return (
      <>
        <Anchors />
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
      </>
    );
  }

  if (level === 'normal') {
    return (
      <>
        <Anchors />
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
      </>
    );
  }

  // 'full' —— 选中或大缩放，渲染完整 markdown
  return (
    <>
      <Anchors />
      <FullCardNode card={card} isIndex={isIndex} isSelected={isSelected} />
    </>
  );
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
