import { useEffect, useMemo, useRef, useState } from 'react';
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
  /** INDEX 分级：0 = master（没被任何 INDEX 引用），1+ = sub-INDEX 的层数 */
  indexTier: number;
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

/**
 * 算每张 INDEX 卡的 tier：
 *   tier 0 = master（没有其他 INDEX 把它列在 crossLinks 里）
 *   tier 1+ = sub-INDEX，值 = 离最近的 master 的层数
 * 用 BFS 拓扑算法，从 tier 0 起逐层扩散。
 */
function computeIndexTiers(cards: CardSummary[]): Map<string, number> {
  const indexes = cards.filter((c) => c.status === 'INDEX');
  const idToCard = new Map(indexes.map((c) => [c.luhmannId, c]));
  // parent map: index id → INDEX 父集合（哪些 INDEX 把它当成员）
  const parentsOf = new Map<string, Set<string>>();
  for (const c of indexes) parentsOf.set(c.luhmannId, new Set());
  for (const c of indexes) {
    for (const t of c.crossLinks) {
      if (idToCard.has(t)) parentsOf.get(t)!.add(c.luhmannId);
    }
  }
  const tier = new Map<string, number>();
  // master = 没被任何 INDEX 引用
  const queue: string[] = [];
  for (const c of indexes) {
    if (parentsOf.get(c.luhmannId)!.size === 0) {
      tier.set(c.luhmannId, 0);
      queue.push(c.luhmannId);
    }
  }
  // BFS：子 INDEX 的 tier = 父最小 tier + 1
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curTier = tier.get(cur)!;
    const card = idToCard.get(cur);
    if (!card) continue;
    for (const child of card.crossLinks) {
      if (!idToCard.has(child)) continue;
      const existing = tier.get(child);
      const next = curTier + 1;
      if (existing == null || next < existing) {
        tier.set(child, next);
        queue.push(child);
      }
    }
  }
  // 兜底：环路里的 INDEX 没被赋 tier → 给个 1
  for (const c of indexes) {
    if (!tier.has(c.luhmannId)) tier.set(c.luhmannId, 1);
  }
  return tier;
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
  const indexTiers = useMemo(
    () => (cardsQ.data ? computeIndexTiers(cardsQ.data.cards) : new Map<string, number>()),
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
          indexTier: indexTiers.get(c.luhmannId) ?? -1,
        } satisfies GraphNodeData,
        width: NODE_W,
        height: NODE_H,
      };
    });
  }, [cardsQ.data, positions, selectedId, indexTiers]);

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
          type: 'default',
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
    <div className="w-full h-full flex flex-col bg-gray-100 dark:bg-[#181926]">
      {/* 顶部 inline 工具栏 —— 不浮动避免分屏挤碎 */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-[#1e2030] border-b border-gray-200 dark:border-[#363a4f] overflow-x-auto">
        <EdgeToggle color="#94a3b8" label="Hierarchy" active={toggles.hierarchy} onClick={() => flip('hierarchy')} />
        <EdgeToggle color="#7c4dff" label="Link" active={toggles.link} onClick={() => flip('link')} />
        <EdgeToggle color="#10b981" label="Tag" active={toggles.tag} onClick={() => flip('tag')} />
        <EdgeToggle color="#f59e0b" label="Box" active={toggles.box} onClick={() => flip('box')} />
        <div className="flex-1" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
          {cardsQ.data.cards.length} cards
        </span>
      </div>
      <div className="flex-1 relative min-h-0">
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
        <Background id="graph-bg" gap={32} size={1.5} color="#cbd5e1" />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap pannable zoomable position="top-right" maskColor="rgba(0,0,0,0.04)" />
      </ReactFlow>

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

/** 隐形 handles —— top + bottom，给 React Flow default 边类型作 anchor */
function Anchors() {
  const s = { opacity: 0, pointerEvents: 'none' as const };
  return (
    <>
      <Handle type="source" position={Position.Top} id="t" style={s} />
      <Handle type="target" position={Position.Top} id="t-in" style={s} />
      <Handle type="source" position={Position.Bottom} id="b" style={s} />
      <Handle type="target" position={Position.Bottom} id="b-in" style={s} />
    </>
  );
}

/** 单节点：根据 zoom + selected 切渲染密度 */
function GraphNode({ data }: { data: GraphNodeData }) {
  const { card, isIndex, isSelected, indexTier } = data;
  // INDEX tier → 视觉等级
  // tier 0 = master：最大、金色 ring
  // tier 1 = domain：标准 accent
  // tier 2+ = sub：较小、半透明 accent
  // 非 INDEX：indexTier = -1
  const tierTone = isIndex
    ? indexTier === 0
      ? { dotMul: 1.6, badgeMul: 1.2, ring: 'ring-amber-500', fill: 'bg-amber-500', text: 'text-white', border: 'border-amber-500' }
      : indexTier === 1
        ? { dotMul: 1.2, badgeMul: 1.0, ring: 'ring-accent', fill: 'bg-accent', text: 'text-white', border: 'border-accent' }
        : { dotMul: 1.0, badgeMul: 0.85, ring: 'ring-accent/60', fill: 'bg-accent/70', text: 'text-white', border: 'border-accent/60' }
    : { dotMul: 1.0, badgeMul: 1.0, ring: 'ring-accent', fill: '', text: '', border: '' };
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
    const baseSize = isIndex ? 28 : 16;
    const size = baseSize * tierTone.dotMul;
    return (
      <>
        <Anchors />
        <div
          className={`rounded-full shadow-md transition-colors ${
            isIndex ? tierTone.fill : 'bg-gray-500 dark:bg-[#a5adcb]'
          } ${isSelected ? `ring-4 ${tierTone.ring} ring-offset-2 dark:ring-offset-[#1e2030]` : ''}`}
          style={{
            width: size,
            height: size,
            marginLeft: NODE_W / 2 - size / 2,
            marginTop: NODE_H / 2 - size / 2,
          }}
          title={`${card.luhmannId} · ${card.title}`}
        />
      </>
    );
  }

  if (level === 'mini') {
    const baseD = isIndex ? 80 : 64;
    const D = baseD * tierTone.badgeMul;
    return (
      <>
        <Anchors />
        <div
          className={`rounded-full flex items-center justify-center font-mono font-bold shadow-md ${
            isSelected ? `ring-4 ${tierTone.ring} ring-offset-2 dark:ring-offset-[#1e2030]` : ''
          } ${
            isIndex
              ? `${tierTone.fill} ${tierTone.text} text-[14px]`
              : 'bg-white dark:bg-[#363a4f] text-gray-700 dark:text-[#cad3f5] border-2 border-gray-300 dark:border-[#494d64] text-[12px]'
          }`}
          style={{
            width: D,
            height: D,
            marginLeft: NODE_W / 2 - D / 2,
            marginTop: NODE_H / 2 - D / 2,
          }}
          title={`${card.luhmannId} · ${card.title}${isIndex ? ` · tier ${indexTier}` : ''}`}
        >
          {card.luhmannId}
        </div>
      </>
    );
  }

  if (level === 'normal') {
    // master 大方块，sub 小方块
    const W = isIndex && indexTier === 0 ? 170 : isIndex && indexTier >= 2 ? 120 : 140;
    const H = isIndex && indexTier === 0 ? 130 : isIndex && indexTier >= 2 ? 95 : 110;
    return (
      <>
        <Anchors />
        <div
          className={`rounded-2xl shadow-md flex flex-col items-center justify-center text-center px-2 py-2 ${
            isSelected ? `ring-4 ${tierTone.ring} ring-offset-2 dark:ring-offset-[#1e2030]` : ''
          } ${
            isIndex
              ? `${tierTone.fill} ${tierTone.text} border-2 ${tierTone.border}`
              : 'bg-white dark:bg-[#363a4f] border-2 border-gray-200 dark:border-[#494d64]'
          }`}
          style={{
            width: W,
            height: H,
            marginLeft: NODE_W / 2 - W / 2,
            marginTop: NODE_H / 2 - H / 2,
          }}
        >
          {isIndex && (
            <span className={`text-[8px] font-black uppercase tracking-widest mb-0.5 ${tierTone.text === 'text-white' ? 'text-white/80' : ''}`}>
              {indexTier === 0 ? 'MASTER' : indexTier === 1 ? 'INDEX' : `SUB·${indexTier}`}
            </span>
          )}
          <span
            className={`font-mono font-bold ${isIndex && indexTier === 0 ? 'text-[15px]' : 'text-[13px]'} ${
              isIndex ? tierTone.text : 'text-accent'
            }`}
          >
            {card.luhmannId}
          </span>
          <span
            className={`text-[11px] mt-1 line-clamp-2 ${
              isIndex ? `${tierTone.text === 'text-white' ? 'text-white/90' : ''}` : 'text-ink dark:text-[#cad3f5]'
            }`}
          >
            {card.title || card.luhmannId}
          </span>
          {card.tags.length > 0 && (
            <div className="flex flex-wrap justify-center gap-x-1 mt-1">
              {card.tags.slice(0, 2).map((t) => (
                <span
                  key={t}
                  className={`text-[8px] font-bold ${isIndex ? (tierTone.text === 'text-white' ? 'text-white/80' : '') : 'text-accent'}`}
                >
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
