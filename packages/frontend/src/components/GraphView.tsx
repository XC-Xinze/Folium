import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { renderMarkdown } from '../lib/markdown';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { select } from 'd3-selection';
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import { drag as d3drag, type D3DragEvent } from 'd3-drag';
import { api, type CardSummary } from '../lib/api';
import { useNavigateToCard } from '../lib/useNavigateToCard';

/**
 * Vault Graph —— Obsidian 风：裸 SVG + d3-force + d3-zoom + d3-drag。
 * 不走 React Flow（之前那套有线条错位、拖拽闪烁、hover 抢焦等问题）。
 *
 * 核心思路：
 *   - sim 跑在后台，每 tick 用 d3 selection 直接改 SVG 属性 → 不进 React reconcile
 *   - 节点是 <circle>（dot 模式）或 <g>（含 circle + text，mini/normal 模式）
 *   - 边是 <line>，端点 = 节点中心。circle 实色覆盖中心部分 → 视觉上从边缘射出
 *   - zoom 用 d3-zoom，<g> root transform，独立追踪当前 k 用于切换显示密度
 *   - drag 用 d3-drag，期间钉死 fx/fy
 */

type LinkKind = 'link' | 'tag' | 'box';

interface SimNode extends SimulationNodeDatum {
  id: string;
  card: CardSummary;
  isIndex: boolean;
  tier: number; // INDEX tier（0=master，1+=sub）
  radius: number; // 视觉半径（按 tier 不同）
  rootBox: string;
  clusterX: number;
  clusterY: number;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  kind: LinkKind;
}

const DAILY_ROOT = '__daily__';

function parentOf(id: string): string | null {
  if (!id || !/^[\da-z]+$/i.test(id)) return null;
  if (/\d$/.test(id)) return id.replace(/\d+$/, '') || null;
  if (/[a-z]$/i.test(id)) return id.replace(/[a-z]+$/i, '') || null;
  return null;
}

function topBoxOf(id: string, cardSet: Set<string>): string {
  if (/^daily\d{8}$/i.test(id)) return DAILY_ROOT;
  if (!/^[\da-z]+$/i.test(id)) return 'other';
  let cur = id;
  while (true) {
    const parent = parentOf(cur);
    if (!parent || !cardSet.has(parent)) return cur;
    cur = parent;
  }
}

function jitterFor(id: string, axis: 0 | 1): number {
  let hash = axis === 0 ? 2166136261 : 16777619;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000 - 0.5;
}

function computeIndexTiers(cards: CardSummary[]): Map<string, number> {
  const indexes = cards.filter((c) => c.status === 'INDEX');
  const idToCard = new Map(indexes.map((c) => [c.luhmannId, c]));
  const parentsOf = new Map<string, Set<string>>();
  for (const c of indexes) parentsOf.set(c.luhmannId, new Set());
  for (const c of indexes) {
    for (const t of c.crossLinks) {
      if (idToCard.has(t)) parentsOf.get(t)!.add(c.luhmannId);
    }
  }
  const tier = new Map<string, number>();
  const queue: string[] = [];
  for (const c of indexes) {
    if (parentsOf.get(c.luhmannId)!.size === 0) {
      tier.set(c.luhmannId, 0);
      queue.push(c.luhmannId);
    }
  }
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
  for (const c of indexes) if (!tier.has(c.luhmannId)) tier.set(c.luhmannId, 1);
  return tier;
}

function buildSimGraph(cards: CardSummary[]): { nodes: SimNode[]; links: SimLink[] } {
  const cardSet = new Set(cards.map((c) => c.luhmannId));
  const tiers = computeIndexTiers(cards);
  const rootById = new Map(cards.map((c) => [c.luhmannId, topBoxOf(c.luhmannId, cardSet)]));
  const roots = [...new Set(cards.map((c) => rootById.get(c.luhmannId) ?? 'other'))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const clusterRadius = Math.max(180, Math.min(460, roots.length * 70));
  const clusterByRoot = new Map<string, { x: number; y: number }>();
  roots.forEach((root, i) => {
    if (roots.length === 1) {
      clusterByRoot.set(root, { x: 0, y: 0 });
      return;
    }
    const angle = -Math.PI / 2 + (i / roots.length) * Math.PI * 2;
    clusterByRoot.set(root, {
      x: Math.cos(angle) * clusterRadius,
      y: Math.sin(angle) * clusterRadius,
    });
  });
  const nodes: SimNode[] = cards.map((c) => {
    const tier = c.status === 'INDEX' ? tiers.get(c.luhmannId) ?? 1 : -1;
    // 半径：master 大、sub 中、atomic 小
    const r = c.status === 'INDEX' ? (tier === 0 ? 22 : tier === 1 ? 16 : 12) : 7;
    const rootBox = rootById.get(c.luhmannId) ?? 'other';
    const cluster = clusterByRoot.get(rootBox) ?? { x: 0, y: 0 };
    return {
      id: c.luhmannId,
      card: c,
      isIndex: c.status === 'INDEX',
      tier,
      radius: r,
      rootBox,
      clusterX: cluster.x,
      clusterY: cluster.y,
      x: cluster.x + jitterFor(c.luhmannId, 0) * 120,
      y: cluster.y + jitterFor(c.luhmannId, 1) * 120,
    };
  });
  const links: SimLink[] = [];
  const seen = new Set<string>();

  const addLink = (source: string, target: string, kind: LinkKind) => {
    if (source === target || !cardSet.has(source) || !cardSet.has(target)) return;
    const pair = [source, target].sort().join('<>');
    const k = `${kind}:${pair}`;
    if (seen.has(k)) return;
    seen.add(k);
    links.push({ source, target, kind });
  };

  // daily notes belong to the daily box.
  const dailyIds = cards
    .filter((c) => /^daily\d{8}$/i.test(c.luhmannId))
    .map((c) => c.luhmannId)
    .sort();
  for (let i = 1; i < dailyIds.length; i++) {
    const source = dailyIds[i - 1]!;
    const target = dailyIds[i]!;
    addLink(source, target, 'box');
  }
  // box: Folgezettel parent-child structure inside each top-level box.
  for (const c of cards) {
    const p = parentOf(c.luhmannId);
    if (p && cardSet.has(p)) {
      addLink(p, c.luhmannId, 'box');
    }
  }
  // link: 手动 [[link]] 之间（非 INDEX）
  for (const c of cards) {
    if (c.status === 'INDEX') continue;
    for (const t of c.crossLinks) {
      addLink(c.luhmannId, t, 'link');
    }
  }
  // tag: 共享 tag，跳宽泛 tag
  const tagToCards = new Map<string, string[]>();
  for (const c of cards) for (const t of c.tags) {
    if (!tagToCards.has(t)) tagToCards.set(t, []);
    tagToCards.get(t)!.push(c.luhmannId);
  }
  for (const [, ids] of tagToCards) {
    if (ids.length > 20) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        addLink(ids[i]!, ids[j]!, 'tag');
      }
    }
  }
  return { nodes, links };
}

interface EdgeToggles {
  link: boolean;
  tag: boolean;
  box: boolean;
}
const DEFAULT_TOGGLES: EdgeToggles = {
  link: true,
  tag: false,
  box: true,
};
const GRAPH_TOGGLES_STORAGE_KEY = 'folium.graph.edgeToggles.v2';

function readStoredGraphToggles(): EdgeToggles {
  if (typeof window === 'undefined') return DEFAULT_TOGGLES;
  try {
    const raw = window.localStorage.getItem(GRAPH_TOGGLES_STORAGE_KEY);
    if (!raw) return DEFAULT_TOGGLES;
    const parsed = JSON.parse(raw) as Partial<EdgeToggles>;
    return {
      link: typeof parsed.link === 'boolean' ? parsed.link : DEFAULT_TOGGLES.link,
      tag: typeof parsed.tag === 'boolean' ? parsed.tag : DEFAULT_TOGGLES.tag,
      box: typeof parsed.box === 'boolean' ? parsed.box : DEFAULT_TOGGLES.box,
    };
  } catch {
    return DEFAULT_TOGGLES;
  }
}

const EDGE_COLOR: Record<LinkKind, string> = {
  link: 'var(--zk-link-edge)',
  tag: '#7a6bb7',
  box: 'var(--zk-rust)',
};

const GRAPH_SURFACE = 'var(--zk-paper)';
const GRAPH_PAPER_EDGE = 'var(--zk-paper-edge)';
const GRAPH_INK = 'var(--zk-ink)';
const GRAPH_MUTED = 'var(--zk-muted)';
const GRAPH_MOSS = 'var(--zk-accent)';
const GRAPH_BLUE = 'var(--zk-link-edge)';
const GRAPH_RUST = 'var(--zk-rust)';
const GRAPH_TAG = '#7a6bb7';

function GraphInner() {
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const navigate = useNavigateToCard();
  const qc = useQueryClient();
  const svgRef = useRef<SVGSVGElement>(null);
  const [toggles, setToggles] = useState<EdgeToggles>(() => readStoredGraphToggles());
  const togglesRef = useRef(toggles);
  togglesRef.current = toggles;
  const [zoom, setZoom] = useState(1);
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  // d3 渲染：cardsQ.data 变化时重建 sim + DOM 绑定
  useEffect(() => {
    if (!svgRef.current || !cardsQ.data) return;
    const cards = cardsQ.data.cards;
    const { nodes, links } = buildSimGraph(cards);

    const svg = select(svgRef.current);
    svg.selectAll('*').remove();

    const root = svg.append('g').attr('class', 'zoom-layer');
    const linkLayer = root.append('g').attr('class', 'links');
    const nodeLayer = root.append('g').attr('class', 'nodes');

    // 绘边
    let linkSel = linkLayer
      .selectAll<SVGLineElement, SimLink>('line')
      .data(links)
      .enter()
      .append('line')
      .attr('stroke', (d) => EDGE_COLOR[d.kind])
      .attr('stroke-width', (d) => (d.kind === 'box' ? 1.35 : 1))
      .attr('stroke-opacity', (d) => (d.kind === 'box' ? 0.46 : 0.36))
      .attr('stroke-dasharray', (d) => (d.kind === 'box' ? '4 3' : null))
      .style('display', (d) => (togglesRef.current[d.kind] ? '' : 'none'));

    // 绘节点 group：含 circle + text
    const nodeG = nodeLayer
      .selectAll<SVGGElement, SimNode>('g.node')
      .data(nodes, (d) => d.id)
      .enter()
      .append('g')
      .attr('class', 'node')
      .style('cursor', 'pointer');

    nodeG
      .append('circle')
      .attr('class', 'focus-ring')
      .attr('r', (d) => d.radius + 7)
      .attr('fill', 'none')
      .attr('stroke', 'var(--zk-rust)')
      .attr('stroke-width', 1.4)
      .attr('stroke-opacity', 0)
      .attr('pointer-events', 'none');

    nodeG
      .append('circle')
      .attr('class', 'node-circle')
      .attr('r', (d) => d.radius)
      .attr('fill', (d) => fillFor(d, false))
      .attr('stroke', (d) => strokeFor(d, false))
      .attr('stroke-width', (d) => (d.isIndex ? 1.6 : 1.2))
      .style('filter', (d) =>
        d.isIndex
          ? 'drop-shadow(0 8px 18px rgba(45,45,45,0.13))'
          : 'drop-shadow(0 4px 12px rgba(45,45,45,0.08))',
      );

    nodeG
      .append('text')
      .attr('class', 'id-label')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .attr('font-family', 'var(--font-mono), ui-monospace, monospace')
      .attr('font-weight', 700)
      .attr('font-size', 9)
      .attr('fill', (d) => (d.isIndex ? 'var(--zk-paper)' : GRAPH_MUTED))
      .attr('pointer-events', 'none')
      .text((d) => d.card.luhmannId);

    nodeG
      .append('text')
      .attr('class', 'title-label')
      .attr('text-anchor', 'middle')
      .attr('dy', (d) => d.radius + 12)
      .attr('font-family', 'var(--font-display), Newsreader, Georgia, serif')
      .attr('font-size', (d) => (d.isIndex ? 12 : 11))
      .attr('font-weight', (d) => (d.isIndex ? 600 : 500))
      .attr('fill', GRAPH_INK)
      .attr('pointer-events', 'none')
      .text((d) => truncate(d.card.title || d.card.luhmannId, 18));

    // 单击 = 选中（只控制选中态，不导航）
    nodeG.on('click', (event, d) => {
      event.stopPropagation();
      const cur = selectedIdRef.current;
      const next = cur === d.id ? null : d.id;
      setSelectedId(next);
    });
    nodeG
      .on('mouseenter', (_event, d) => setHoveredId(d.id))
      .on('mouseleave', () => setHoveredId(null));
    // 双击 = 进 chain 视图
    nodeG.on('dblclick', (event, d) => {
      event.stopPropagation();
      navigate(d.id);
    });

    // 拖拽
    const drag = d3drag<SVGGElement, SimNode>()
      .on('start', (event: D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        if (!event.active) simRef.current?.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event: D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event: D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        if (!event.active) simRef.current?.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    nodeG.call(drag);

    // 力模拟
    const sim = forceSimulation<SimNode>(nodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((d) => (d.kind === 'box' ? 82 : 140))
          .strength((d) => (d.kind === 'box' ? 0.38 : 0.05)),
      )
      .force(
        'charge',
        forceManyBody<SimNode>().strength((d) => (d.isIndex ? -300 : -120)),
      )
      .force('clusterX', forceX<SimNode>((d) => d.clusterX).strength((d) => (d.isIndex ? 0.045 : 0.014)))
      .force('clusterY', forceY<SimNode>((d) => d.clusterY).strength((d) => (d.isIndex ? 0.045 : 0.014)))
      .force('collide', forceCollide<SimNode>((d) => d.radius + 4))
      .alphaDecay(0.03);

    simRef.current = sim;

    const renderTick = () => {
      linkSel
        .attr('x1', (d) => (d.source as SimNode).x ?? 0)
        .attr('y1', (d) => (d.source as SimNode).y ?? 0)
        .attr('x2', (d) => (d.target as SimNode).x ?? 0)
        .attr('y2', (d) => (d.target as SimNode).y ?? 0);
      nodeG.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    };

    sim.stop();
    sim.tick(90);
    renderTick();

    // 缩放 + 平移
    const zoomBeh = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 5])
      .on('zoom', (event) => {
        root.attr('transform', event.transform);
        setZoom(event.transform.k);
      });
    svg.call(zoomBeh);
    // 初始居中：图的世界坐标围绕 (0,0) 分群，SVG 视口原点在左上角，
    // 所以必须把世界原点平移到容器中心。
    const rect = svgRef.current.getBoundingClientRect();
    const initialK = 0.78;
    svg.call(
      zoomBeh.transform,
      zoomIdentity.translate(rect.width / 2, rect.height / 2).scale(initialK),
    );
    zoomBehaviorRef.current = zoomBeh;

    const fitToNodes = () => {
      if (!svgRef.current || nodes.length === 0) return;
      const bounds = nodes.reduce(
        (acc, node) => {
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          return {
            minX: Math.min(acc.minX, x - node.radius),
            maxX: Math.max(acc.maxX, x + node.radius),
            minY: Math.min(acc.minY, y - node.radius),
            maxY: Math.max(acc.maxY, y + node.radius),
          };
        },
        { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
      );
      const nextRect = svgRef.current.getBoundingClientRect();
      const graphW = Math.max(1, bounds.maxX - bounds.minX);
      const graphH = Math.max(1, bounds.maxY - bounds.minY);
      const padding = 140;
      const k = Math.max(
        0.18,
        Math.min(1.05, Math.min((nextRect.width - padding) / graphW, (nextRect.height - padding) / graphH)),
      );
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      svg.call(
        zoomBeh.transform,
        zoomIdentity.translate(nextRect.width / 2 - cx * k, nextRect.height / 2 - cy * k).scale(k),
      );
    };
    fitToNodes();
    sim.alpha(0.28).restart();
    sim.on('tick', renderTick);

    // 点空白取消选中
    svg.on('click', () => setSelectedId(null));

    // 暴露 linkSel/nodeG 给后续 toggle/select effect 用 —— 通过返回对象不行，改在 closure 里
    // 这里用另一个 effect 做 toggle 重绘会更优雅。先存 dataset 标记
    void linkSel;

    return () => {
      sim.stop();
      simRef.current = null;
      svg.on('.zoom', null);
    };
  }, [cardsQ.data, navigate]);

  // toggle 改变 → 边可见性
  useEffect(() => {
    window.localStorage.setItem(GRAPH_TOGGLES_STORAGE_KEY, JSON.stringify(toggles));
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    svg
      .select('.links')
      .selectAll<SVGLineElement, SimLink>('line')
      .style('display', (d) => (toggles[d.kind] ? '' : 'none'));
  }, [toggles]);

  // selectedId / hoveredId 变 → 节点高亮 + 一层邻接边强调
  useEffect(() => {
    if (!svgRef.current || !cardsQ.data) return;
    const svg = select(svgRef.current);
    const nodeG = svg.select('.nodes').selectAll<SVGGElement, SimNode>('g.node');
    const linkSel = svg.select('.links').selectAll<SVGLineElement, SimLink>('line');
    const focusId = selectedId ?? hoveredId;

    nodeG
      .select('circle.focus-ring')
      .attr('r', (d) => (d.id === focusId ? d.radius + 8 : d.radius + 6))
      .attr('stroke-opacity', (d) => (d.id === focusId ? 0.62 : 0))
      .attr('stroke-width', (d) => (d.id === focusId ? 1.8 : 1.2));

    nodeG
      .select('circle.node-circle')
      .attr('fill', (d) => fillFor(d, d.id === focusId))
      .attr('stroke', (d) => strokeFor(d, d.id === focusId))
      .attr('stroke-width', (d) => (d.id === focusId ? 3 : d.isIndex ? 1.6 : 1.2))
      .style('filter', (d) =>
        d.id === focusId
          ? 'drop-shadow(0 14px 30px rgba(186,99,92,0.18))'
          : d.isIndex
            ? 'drop-shadow(0 8px 18px rgba(45,45,45,0.13))'
            : 'drop-shadow(0 4px 12px rgba(45,45,45,0.08))',
      );

    if (focusId) {
      // 找跟 focus 相连的一层 ids
      const neighborIds = new Set<string>([focusId]);
      linkSel.each((d) => {
        const sId = (d.source as SimNode).id;
        const tId = (d.target as SimNode).id;
        if (sId === focusId) neighborIds.add(tId);
        if (tId === focusId) neighborIds.add(sId);
      });
      linkSel
        .attr('stroke-opacity', (d) => {
          const sId = (d.source as SimNode).id;
          const tId = (d.target as SimNode).id;
          if (sId === focusId || tId === focusId) return 1;
          return selectedId ? 0.07 : 0.14;
        })
        .attr('stroke-width', (d) => {
          const sId = (d.source as SimNode).id;
          const tId = (d.target as SimNode).id;
          const base = d.kind === 'box' ? 1.35 : 1;
          return sId === focusId || tId === focusId ? base + 1.8 : base;
        });
      nodeG.style('opacity', (d) => (neighborIds.has(d.id) ? 1 : selectedId ? 0.25 : 0.55));
    } else {
      linkSel
        .attr('stroke-opacity', (d) => (d.kind === 'box' ? 0.46 : 0.36))
        .attr('stroke-width', (d) => (d.kind === 'box' ? 1.35 : 1));
      nodeG.style('opacity', 1);
    }
  }, [selectedId, hoveredId, cardsQ.data]);

  // 选中节点的屏幕坐标（带 zoom transform）—— 给 React overlay 卡用
  // 由 sim tick / zoom 更新；避免 d3-html foreignObject 的命名空间坑
  const [overlayPos, setOverlayPos] = useState<{ x: number; y: number } | null>(null);
  const overlayPosRef = useRef<typeof overlayPos>(null);
  overlayPosRef.current = overlayPos;
  useEffect(() => {
    if (!svgRef.current || !cardsQ.data || !selectedId) {
      setOverlayPos(null);
      return;
    }
    const svg = select(svgRef.current);
    const update = () => {
      if (!svgRef.current) return;
      const g = svg
        .select('.nodes')
        .selectAll<SVGGElement, SimNode>('g.node')
        .filter((d) => d.id === selectedId)
        .node();
      if (!g) {
        setOverlayPos(null);
        return;
      }
      // getCTM —— g 在 SVG 内的最终矩阵（含 zoom transform）
      const ctm = g.getCTM();
      if (!ctm) return;
      const rect = svgRef.current.getBoundingClientRect();
      // 节点中心在 g 自己的 (0,0)
      // 转 SVG 用户坐标 → 屏幕坐标
      const svgPoint = svgRef.current.createSVGPoint();
      svgPoint.x = 0;
      svgPoint.y = 0;
      const screen = svgPoint.matrixTransform(ctm);
      setOverlayPos({ x: screen.x, y: screen.y });
    };
    update();
    // sim tick 期间节点移动 → 持续更新
    const interval = window.setInterval(update, 40);
    return () => window.clearInterval(interval);
  }, [selectedId, cardsQ.data]);

  // 拉选中卡的完整内容（用 useQuery，缓存 + 自动 refetch）
  const selectedCardQ = useQuery({
    queryKey: ['card', selectedId ?? '__none__'],
    queryFn: () => api.getCard(selectedId!),
    enabled: !!selectedId,
  });
  void qc;

  // 缩放 → 标题文本可见性
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    const showTitle = zoom >= 1.0;
    svg.selectAll('text.title-label').style('display', showTitle ? '' : 'none');
    // id 文字在小 zoom 时藏起来（节点小看不清反而干扰）
    const showId = zoom >= 0.5;
    svg.selectAll('text.id-label').style('display', showId ? '' : 'none');
  }, [zoom]);

  if (cardsQ.isLoading)
    return <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">Loading…</div>;
  if (!cardsQ.data?.cards.length)
    return <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">Vault is empty.</div>;

  const flip = (k: keyof EdgeToggles) => setToggles((s) => ({ ...s, [k]: !s[k] }));

  return (
    <div className="w-full h-full flex flex-col bg-surface dark:bg-[#181926]">
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 zk-toolbar-surface border-b overflow-x-auto">
        <EdgeToggle color={GRAPH_BLUE} label="Link" active={toggles.link} onClick={() => flip('link')} title="Real manual [[link]] relations" />
        <EdgeToggle color={GRAPH_TAG} label="Tag" active={toggles.tag} onClick={() => flip('tag')} title="Shared-tag relations, excluding very broad tags" />
        <EdgeToggle color={GRAPH_RUST} label="Box" active={toggles.box} onClick={() => flip('box')} title="Folgezettel parent-child structure inside each top-level box" />
        <div className="flex-1" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
          {cardsQ.data.cards.length} cards · zoom {zoom.toFixed(2)}x · click select · dbl open · drag move
        </span>
      </div>
      <div className="flex-1 relative overflow-hidden zk-canvas-bg">
        <svg ref={svgRef} className="w-full h-full" />
        {selectedId && overlayPos && selectedCardQ.data && (
          <SelectedCardOverlay
            card={selectedCardQ.data}
            x={overlayPos.x}
            y={overlayPos.y}
            onClose={() => setSelectedId(null)}
            onOpen={() => navigate(selectedId)}
          />
        )}
      </div>
    </div>
  );
}

/** 选中卡浮在 svg 上方，定位在节点中心。位置实时跟随 sim+zoom（每 40ms 重算）。 */
function SelectedCardOverlay({
  card,
  x,
  y,
  onClose,
  onOpen,
}: {
  card: { luhmannId: string; title: string; status: string; tags: string[]; contentMd: string };
  x: number;
  y: number;
  onClose: () => void;
  onOpen: () => void;
}) {
  const html = useMemo(() => renderMarkdown(card.contentMd), [card.contentMd]);
  const isIndex = card.status === 'INDEX';
  const W = 320;
  const H = 240;
  return (
    <div
      className={`absolute pointer-events-auto rounded-lg zk-paper-surface flex flex-col overflow-hidden border backdrop-blur ${
        isIndex
          ? 'text-ink border-accent'
          : 'border-paperEdge text-ink'
      }`}
      style={{
        left: x - W / 2,
        top: y - H / 2,
        width: W,
        height: H,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <header className="flex items-center gap-2 px-4 py-3 border-b border-paperEdge/70 bg-gradient-to-b from-white/55 to-transparent dark:from-white/5 shrink-0">
        <span className={`font-mono font-bold text-[11px] ${isIndex ? 'text-accent' : 'text-link'}`}>
          {card.luhmannId}
        </span>
        <span className="font-display text-[18px] font-semibold leading-tight flex-1 truncate">
          {card.title || card.luhmannId}
        </span>
        <button
          onClick={onOpen}
          className="text-[10px] font-bold px-2 py-0.5 rounded border border-accent/30 bg-accentSoft/70 text-accent hover:bg-accent hover:text-white"
          title="Open as chain view (or double-click node)"
        >
          Open
        </button>
        <button
          onClick={onClose}
          className="text-[14px] leading-none px-1 rounded text-gray-400 hover:bg-surfaceAlt hover:text-ink"
          title="Close"
        >
          ×
        </button>
      </header>
      <div
        className="prose-card text-[12px] px-4 py-3 overflow-y-auto flex-1"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {card.tags.length > 0 && (
        <div className="px-4 py-2 border-t border-paperEdge/70 bg-[#fffdf8]/45 dark:bg-white/5 flex flex-wrap gap-1.5 shrink-0">
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

function fillFor(d: SimNode, selected: boolean): string {
  void selected;
  if (d.isIndex) {
    if (d.tier === 0) return GRAPH_RUST;
    if (d.tier === 1) return GRAPH_MOSS;
    return '#7f927d';
  }
  return GRAPH_SURFACE;
}

function strokeFor(d: SimNode, selected: boolean): string {
  if (selected) return 'var(--zk-rust)';
  if (d.isIndex) return d.tier === 0 ? GRAPH_RUST : GRAPH_MOSS;
  return GRAPH_PAPER_EDGE;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-widest transition-all ${
        active
          ? 'text-ink border-accent/40 bg-accentSoft hover:border-accent/60'
          : 'text-gray-400 dark:text-[#a5adcb] border-transparent hover:text-gray-600 dark:hover:text-[#cad3f5] hover:bg-surfaceAlt'
      }`}
    >
      <span
        className="w-2 h-2 rounded-full transition-all"
        style={{
          backgroundColor: active ? color : 'transparent',
          border: `1.5px solid ${active ? color : 'var(--zk-paper-edge)'}`,
        }}
      />
      {label}
    </button>
  );
}

export function GraphView() {
  return <GraphInner />;
}
