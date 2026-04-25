import dagre from 'dagre';
import type { Edge, Node } from '@xyflow/react';
import type { Card, CardSummary, PositionMap, RelatedBatch, WorkspaceLink } from './api';

export const NODE_WIDTH = 340;
export const NODE_HEIGHT = 380;

// 布局常量
const X_GAP = 80; // 同层兄弟节点间距
const Y_GAP = 130; // 父子层级间距
const FLANK_OFFSET_X = 120; // cross-flank 离行边界的横向距离
const POTENTIAL_OFFSET_X = 40; // potential 与 cross-flank 列之间的间隙（小一点更贴近被链接的卡）

export type CardNodeData = {
  card: Card | CardSummary;
  /**
   * - focus: 当前焦点卡（高亮）
   * - tree: 当前 box 的骨干树成员
   * - cross-flank: 通过手动 [[link]] 进来的"侧翼"卡
   * - tag-related: 通过共享 tag 进来的卡（涌现式关系，一等公民）
   * - potential: 文本/关键字相似度发现的卡（弱关系）
   */
  variant: 'focus' | 'tree' | 'cross-flank' | 'tag-related' | 'potential';
  /** tag-related 时记录共享的 tag，给标签气泡用 */
  sharedTags?: string[];
  sharedBoxes?: string[];
  sharedBoxLabels?: { id: string; title: string }[];
  /** 来自保存的大小（如果有） */
  savedW?: number;
  savedH?: number;
  /** workspace 等场景：覆盖默认的"vault 删卡"为本地删除（仅移除节点引用） */
  onDeleteOverride?: () => void;
  /** 在 workspace 里时隐藏 WS 拖拽手柄（卡片已经在工作区里了） */
  isInWorkspace?: boolean;
  /** Workspace 上下文专用：拖一张卡 drop 到本卡 → 创建 workspace edge（不动 vault） */
  onCardLinkDrop?: (sourceLuhmannId: string) => void;
  /** 来自工作区的"幽灵 temp 节点"——只读、不发请求、只显示标题/正文 */
  ghostFromWorkspace?: { workspaceId: string; workspaceName: string };
  /** 位置存储 scope（box:xxx 或 tag:xxx）—— 由父视图（Canvas/TagView/WorkspaceView）注入，
   *  不再读全局 useUIStore，多 pane 同屏时各算各的 */
  scope?: string;
};

/** 计算每张卡被哪些 INDEX 引用 */
export function computeSharedBoxes(allCards: CardSummary[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const idx of allCards.filter((c) => c.status === 'INDEX')) {
    for (const target of idx.crossLinks) {
      const cur = result.get(target) ?? [];
      if (!cur.includes(idx.luhmannId)) cur.push(idx.luhmannId);
      result.set(target, cur);
    }
  }
  return result;
}

/**
 * Sentinel box id：虚拟 "Master" 盒子。它不是 vault 里真存在的卡，
 * computeBackbone 看到它就把所有顶级 Folgezettel 卡（1, 2, 3...）当作 backbone 成员。
 * Canvas/boxQ/focusQ 看到这个 id 也跳过真卡 fetch。
 */
export const MASTER_BOX_ID = '__MASTER__';

export interface BuildGraphInput {
  allCards: CardSummary[];
  fullCards: Map<string, Card>;
  /** 当前盒子（决定树根）。INDEX 卡 → 走 INDEX 视图；ATOMIC → 走 Folgezettel 视图 */
  focusedBoxId: string;
  /** 当前焦点卡（决定哪张卡有 'focus' 高亮） */
  focusedCardId: string;
  /**
   * Tag 锚点 trail：本 box 会话期间出现过的、有 tag 的焦点卡集合。
   * 每个锚都各自展开自己的 tagRelated，结果在画布上累加 ——
   * 焦点切到下一张 tag 卡，老锚的邻居不消失，新锚的邻居也加进来。
   * Box 切换会重置为 [boxId]。Potential 卡（无 tag）不进 trail。
   */
  tagAnchorIds: string[];
  /** 每张骨干卡的关联（仅 backbone 外部的卡才会被采用为 potential） */
  relatedBatch: RelatedBatch;
  showPotential: boolean;
  /** 默认 true：显示绿色 tag 共现边/节点 */
  showTagRelated?: boolean;
  /** 默认 true：显示紫色手动 [[link]] cross-flank 边/节点 */
  showCrossLinks?: boolean;
  /** 工作区边（任何 vault 卡参与的）—— 当作 potential 显示在画布上 */
  workspaceLinks?: WorkspaceLink[];
}

/** 用于 ghost temp 节点的合成 luhmannId，避免与真实卡 id 撞车 */
const TEMP_GHOST_PREFIX = '__ws-temp::';
export const tempGhostId = (workspaceId: string, nodeId: string) =>
  `${TEMP_GHOST_PREFIX}${workspaceId}::${nodeId}`;
export const isTempGhost = (id: string) => id.startsWith(TEMP_GHOST_PREFIX);

/* -------- 工具：luhmannId 解析 -------- */

function deriveParentId(luhmannId: string): string | null {
  if (luhmannId.length <= 1) return null;
  const lastChar = luhmannId.at(-1)!;
  const isLastDigit = /\d/.test(lastChar);
  for (let i = luhmannId.length - 2; i >= 0; i--) {
    const ch = luhmannId[i]!;
    const isDigit = /\d/.test(ch);
    if (isDigit !== isLastDigit) return luhmannId.slice(0, i + 1);
  }
  return null;
}

/* -------- 1. 计算骨干 -------- */

interface Backbone {
  ids: Set<string>;
  treeEdges: { source: string; target: string }[];
  /** 每张骨干卡的"逻辑深度"——focused = 0，下游正数，上游负数 */
  depth: Map<string, number>;
}

export function computeBackbone(
  focusedId: string,
  allCards: CardSummary[],
  fullCards: Map<string, Card>,
): Backbone {
  const ids = new Set<string>();
  const treeEdges: { source: string; target: string }[] = [];
  const depth = new Map<string, number>();

  // Master 模式：backbone 只有顶级卡（没 Folgezettel 父，或父在 vault 里不存在）。
  // 不展开子树 —— 用户说 master 只装最顶级 index，不显示更深的子卡。
  // 同时排除 daily 卡（它们走 Sidebar 的 DAILY 区独立展示）。
  if (focusedId === MASTER_BOX_ID) {
    const cardSet = new Set(allCards.map((c) => c.luhmannId));
    const dailyRe = /^daily\d{8}/;
    for (const c of allCards) {
      if (!/^[\da-z]+$/i.test(c.luhmannId)) continue;
      if (dailyRe.test(c.luhmannId)) continue;
      const parent = deriveParentId(c.luhmannId);
      if (!parent || !cardSet.has(parent)) {
        ids.add(c.luhmannId);
        depth.set(c.luhmannId, 0);
      }
    }
    void fullCards;
    return { ids, treeEdges, depth };
  }

  // 普通 box：以 focusedBoxId 为根，BFS 收集 Folgezettel 后代。
  // INDEX 现在是 derived（有 Folgezettel 子卡的卡），子卡靠 id 自动归属。
  // crossLinks 不再参与 backbone 收集 —— 它们走 cross-flank 边渲染。
  ids.add(focusedId);
  depth.set(focusedId, 0);
  const queue: string[] = [focusedId];
  while (queue.length) {
    const cur = queue.shift()!;
    const curDepth = depth.get(cur)!;
    for (const c of allCards) {
      if (deriveParentId(c.luhmannId) === cur && !ids.has(c.luhmannId)) {
        ids.add(c.luhmannId);
        treeEdges.push({ source: cur, target: c.luhmannId });
        depth.set(c.luhmannId, curDepth + 1);
        queue.push(c.luhmannId);
      }
    }
  }

  void fullCards;
  return { ids, treeEdges, depth };
}

/* -------- 2. 主入口：构建完整图 -------- */

export function buildGraph(input: BuildGraphInput): { nodes: Node[]; edges: Edge[] } {
  const {
    allCards,
    fullCards,
    focusedBoxId,
    focusedCardId,
    tagAnchorIds,
    relatedBatch,
    showPotential,
    showTagRelated = true,
    showCrossLinks = true,
    workspaceLinks,
  } = input;
  const cardMap = new Map(allCards.map((c) => [c.luhmannId, c]));

  // 树以 box 为根；focus 仅决定哪张卡是 'focus' 变体
  const backbone = computeBackbone(focusedBoxId, allCards, fullCards);

  /* ----- 收集 raw 节点和边 ----- */
  type RawEdgeKind = 'tree' | 'cross' | 'tag' | 'potential';
  interface RawEdge {
    id: string;
    source: string;
    target: string;
    kind: RawEdgeKind;
    /** workspace-derived edge：渲染上跟 potential 一样灰虚线，但不允许 promote/unlink（端点可能是 ghost id） */
    isWsLink?: boolean;
  }
  const sharedBoxes = computeSharedBoxes(allCards);
  // 索引卡 ID → title 映射，用于"来自"标签
  const indexTitle = new Map(
    allCards.filter((c) => c.status === 'INDEX').map((c) => [c.luhmannId, c.title]),
  );

  const rawNodes = new Map<string, CardNodeData>();
  const rawEdges: RawEdge[] = [];

  const addNode = (
    id: string,
    variant: CardNodeData['variant'],
    extra: { sharedTags?: string[] } = {},
  ) => {
    if (rawNodes.has(id)) return;
    const summary = cardMap.get(id);
    if (!summary) return;
    const full = fullCards.get(id);
    const boxes = sharedBoxes.get(id);
    rawNodes.set(id, {
      card: full ?? summary,
      variant,
      sharedBoxes: boxes,
      sharedBoxLabels: boxes?.map((bid) => ({ id: bid, title: indexTitle.get(bid) ?? bid })),
      sharedTags: extra.sharedTags,
    });
  };

  // 骨干节点：只有 focusedCardId 这一张是 'focus'，其他都是 'tree'
  for (const id of backbone.ids) {
    addNode(id, id === focusedCardId ? 'focus' : 'tree');
  }
  // 焦点卡可能不在 backbone（用户在某个 box 里点了外部 tag-related/cross/potential 卡）。
  // 仅当用户至少开着一类外部边（tag/cross/potential）时才补 focus 节点 —— 否则用户已经
  // 明确"我不想看外部"，把外部 focus 也藏掉，跟 toggle 语义一致。
  // 后续的 cross / tag / potential 边以此 focus 为端点也都被对应 toggle 控住。
  const anyExternalToggle = showTagRelated || showCrossLinks || showPotential;
  if (
    !backbone.ids.has(focusedCardId) &&
    cardMap.has(focusedCardId) &&
    anyExternalToggle
  ) {
    addNode(focusedCardId, 'focus');
  }
  // 骨干 tree 边
  for (const e of backbone.treeEdges) {
    rawEdges.push({ id: `tree:${e.source}->${e.target}`, source: e.source, target: e.target, kind: 'tree' });
  }

  // 焦点卡若在 backbone 外（被 tag-related/cross-flank 拉进来后用户点选了它）→
  // 把它也纳入 cross/potential 的迭代集合，让"以焦点为中心的所有边"都画出来
  const radialIds = new Set<string>(backbone.ids);
  if (!radialIds.has(focusedCardId) && cardMap.has(focusedCardId)) {
    radialIds.add(focusedCardId);
  }

  // Cross-link 边：双向都画
  //   出边（outbound）：骨干卡的 crossLinks 指向哪些卡 —— 从 fullCards 抽取
  //   入边（inbound / backlinks）：哪些卡的 crossLinks 指向骨干 —— 用 summary 反向扫描
  if (showCrossLinks) {
    // 出边
    // 用 summary.crossLinks（cardsQ 全量）而不是 fullCards.get(id).crossLinks
    // —— fullCards 只含 focused box/focus/linked，非焦点的 backbone 卡 full 没拉，
    // 用 full 会漏掉它们的 [[link]]。summary 已含 crossLinks，全 backbone 都能用。
    for (const id of radialIds) {
      const summary = cardMap.get(id);
      if (!summary) continue;
      for (const target of summary.crossLinks) {
        if (target === id) continue;
        const existsTree = backbone.treeEdges.some(
          (e) => (e.source === id && e.target === target) || (e.source === target && e.target === id),
        );
        if (existsTree) continue;
        if (!rawNodes.has(target) && cardMap.has(target)) {
          addNode(target, target === focusedCardId ? 'focus' : 'cross-flank');
        }
        if (rawNodes.has(target)) {
          rawEdges.push({
            id: `cross:${id}->${target}`,
            source: id,
            target,
            kind: 'cross',
          });
        }
      }
    }
    // 入边（backlinks）：扫所有卡的 summary.crossLinks，找指向骨干（或外部焦点）的
    for (const c of allCards) {
      if (radialIds.has(c.luhmannId)) continue; // 已在出边里处理
      // 同上：INDEX 卡的 crossLinks 现在也是普通引用，要画 backlink 边
      for (const target of c.crossLinks) {
        if (!radialIds.has(target)) continue;
        const existsTree = backbone.treeEdges.some(
          (e) =>
            (e.source === c.luhmannId && e.target === target) ||
            (e.source === target && e.target === c.luhmannId),
        );
        if (existsTree) continue;
        // 已经被出边处理过这一对就跳过
        const exists = rawEdges.some(
          (e) =>
            e.kind === 'cross' &&
            ((e.source === c.luhmannId && e.target === target) ||
              (e.source === target && e.target === c.luhmannId)),
        );
        if (exists) continue;
        if (!rawNodes.has(c.luhmannId)) {
          addNode(c.luhmannId, c.luhmannId === focusedCardId ? 'focus' : 'cross-flank');
        }
        rawEdges.push({
          id: `cross:${c.luhmannId}->${target}`,
          source: c.luhmannId,
          target,
          kind: 'cross',
        });
      }
    }
  }

  // Tag 共现：first-class 关系，默认显示，绿色实线
  // 涌现式的化学反应——比手动 [[link]] 更本质，比 potential 更可信
  // 优先级：tree > cross > tag。同一对节点已有更"硬"的边则不再叠加绿线（视觉重叠会盖住底下的边）
  const pairHasEdge = (a: string, b: string, kinds: RawEdgeKind[]) =>
    rawEdges.some(
      (e) =>
        kinds.includes(e.kind) &&
        ((e.source === a && e.target === b) || (e.source === b && e.target === a)),
    );
  const pairHasTree = (a: string, b: string) =>
    backbone.treeEdges.some(
      (e) => (e.source === a && e.target === b) || (e.source === b && e.target === a),
    );

  if (showTagRelated) {
    // Trail 模式：每个 tag 锚点都各自展开 tag-related，结果在画布上联合显示
    // —— 焦点切到下一张 tag 卡时，老锚的邻居不消失，新锚的邻居也加进来。
    // Canvas 维护 trail；这里只用 batch 里有数据的那些（缺数据时跳过该锚）。
    // trail 为空时 fallback backbone。
    const anchors = tagAnchorIds.filter((id) => relatedBatch[id]);
    const effectiveAnchors = anchors.length > 0 ? anchors : [...backbone.ids];
    for (const id of effectiveAnchors) {
      const rel = relatedBatch[id];
      if (!rel) continue;
      for (const tr of rel.tagRelated) {
        // 节点已存在（骨干 / 其他锚点的 tag-related） → 复用，加边
        // 即使已经有 tree/cross 边也再画一根 tag 边 —— 用户既然开了 Tag toggle 就是想看见
        // 不同 kind 的边走不同 handle（tree=top/bottom，tag/cross=left/right）所以视觉不会糊
        if (rawNodes.has(tr.luhmannId)) {
          const existing = rawNodes.get(tr.luhmannId)!;
          if (!existing.sharedTags) existing.sharedTags = tr.sharedTags;
          if (!pairHasEdge(id, tr.luhmannId, ['tag'])) {
            rawEdges.push({
              id: `tag:${id}->${tr.luhmannId}`,
              source: id,
              target: tr.luhmannId,
              kind: 'tag',
            });
          }
          continue;
        }
        // 全新 tag-related 节点 —— INDEX 卡也算（INDEX 之间共享 tag 是正经关系，
        // 不要因为"INDEX 是成员关系"就把 tag 关系一起吞掉）
        const summary = cardMap.get(tr.luhmannId);
        if (!summary) continue;
        addNode(
          tr.luhmannId,
          tr.luhmannId === focusedCardId ? 'focus' : 'tag-related',
          { sharedTags: tr.sharedTags },
        );
        rawEdges.push({
          id: `tag:${id}->${tr.luhmannId}`,
          source: id,
          target: tr.luhmannId,
          kind: 'tag',
        });
      }
    }

  }

  // Potential：unlinked references。骨干外的内容卡作为 potential 节点拉进来；
  // 骨干内部之间的 potential 关系也要画一条灰虚线。
  // 优先级：tree > cross > tag > potential。如果这对节点已经有更"硬"的边，就别叠加 potential。
  if (showPotential) {
    for (const id of radialIds) {
      const rel = relatedBatch[id];
      if (!rel) continue;
      for (const p of rel.potential) {
        const summary = cardMap.get(p.luhmannId);
        if (!summary) continue;
        if (summary.status === 'INDEX') continue; // INDEX 卡不能是 potential

        // 已有更硬的边 → 跳过，避免重叠盖住底层
        if (
          pairHasTree(id, p.luhmannId) ||
          pairHasEdge(id, p.luhmannId, ['cross', 'tag'])
        ) {
          continue;
        }
        // 已经画过 potential 边了
        if (pairHasEdge(id, p.luhmannId, ['potential'])) continue;

        // 节点不在图里 → 加进来作为 potential 卡片
        if (!rawNodes.has(p.luhmannId)) {
          addNode(p.luhmannId, p.luhmannId === focusedCardId ? 'focus' : 'potential');
        }
        rawEdges.push({
          id: `pot:${id}->${p.luhmannId}`,
          source: id,
          target: p.luhmannId,
          kind: 'potential',
        });
      }
    }
  }

  // 工作区链接：作为 potential 风格的节点/边叠加到画布上
  //   - card↔card 工作区边：另一端的 vault 卡用 'potential' 变体加入（如果尚未在图中）
  //   - card↔temp 工作区边：合成一个 ghost 节点（带 temp 内容）作为 'potential' 加入
  //   只渲染至少有一端在当前 backbone 视野内的链接，否则与当前焦点无关
  if (workspaceLinks && workspaceLinks.length > 0) {
    const seenWsEdges = new Set<string>();
    for (const link of workspaceLinks) {
      if (seenWsEdges.has(link.edgeId)) continue;

      // backbone 或外部焦点都算"视野内"
      const inView = (cardId: string) =>
        backbone.ids.has(cardId) || cardId === focusedCardId;
      const sourceInView = link.source.kind === 'card' && inView(link.source.id);
      const targetInView = link.target.kind === 'card' && inView(link.target.id);
      if (!sourceInView && !targetInView) continue;
      seenWsEdges.add(link.edgeId);

      // 找到本 link 中的 vault 卡端 + 另一端
      const sourceIsCard = link.source.kind === 'card';
      const targetIsCard = link.target.kind === 'card';

      // 解析两端在画布中的 node id（vault 卡用 luhmannId；temp 用 ghostId）
      const sourceNodeId = sourceIsCard
        ? link.source.id
        : tempGhostId(link.workspaceId, link.source.id);
      const targetNodeId = targetIsCard
        ? link.target.id
        : tempGhostId(link.workspaceId, link.target.id);

      // 如果某端是 card 且不在 backbone（也不在已加节点中），把它当 'potential' 拉进来
      const ensureCardEnd = (cardId: string) => {
        if (rawNodes.has(cardId)) return true;
        const summary = cardMap.get(cardId);
        if (!summary) return false;
        addNode(cardId, cardId === focusedCardId ? 'focus' : 'potential');
        return true;
      };
      // 如果某端是 temp，合成 ghost 节点
      const ensureTempEnd = (
        nodeId: string,
        title: string | undefined,
        content: string | undefined,
        wsId: string,
        wsName: string,
      ) => {
        const id = tempGhostId(wsId, nodeId);
        if (rawNodes.has(id)) return;
        const ghostCard: Card = {
          luhmannId: id,
          title: title || '(untitled temp)',
          status: 'ATOMIC',
          parentId: null,
          sortKey: '',
          depth: 0,
          contentMd: content ?? '',
          tags: [],
          crossLinks: [],
          filePath: '',
          mtime: 0,
          createdAt: null,
          updatedAt: null,
        };
        rawNodes.set(id, {
          card: ghostCard,
          variant: 'potential',
          ghostFromWorkspace: { workspaceId: wsId, workspaceName: wsName },
        });
      };

      let bothInGraph = true;
      if (sourceIsCard) {
        if (!ensureCardEnd(link.source.id)) bothInGraph = false;
      } else {
        ensureTempEnd(link.source.id, link.source.title, link.source.content, link.workspaceId, link.workspaceName);
      }
      if (targetIsCard) {
        if (!ensureCardEnd(link.target.id)) bothInGraph = false;
      } else {
        ensureTempEnd(link.target.id, link.target.title, link.target.content, link.workspaceId, link.workspaceName);
      }
      if (!bothInGraph) continue;

      // 跨 ws 边：用同 'potential' 边样式（虚线浅色），但加 isWsLink 标记
      // 让 PotentialEdge 跳过 Link/Unlink 按钮（避免对 ghost id appendCrossLink 时 404）
      rawEdges.push({
        id: `ws:${link.workspaceId}:${link.edgeId}`,
        source: sourceNodeId,
        target: targetNodeId,
        kind: 'potential',
        isWsLink: true,
      });
    }
  }

  /* ----- 3. 布局：骨干分层居中 + flank 侧翼 ----- */
  const positions = new Map<string, { x: number; y: number }>();

  // 骨干：按 depth 分层
  const layers = new Map<number, string[]>();
  for (const id of backbone.ids) {
    const d = backbone.depth.get(id) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(id);
  }
  for (const [d, layerIds] of layers) {
    layerIds.sort((a, b) => {
      const sa = cardMap.get(a)?.sortKey ?? a;
      const sb = cardMap.get(b)?.sortKey ?? b;
      return sa.localeCompare(sb);
    });
    const totalWidth = layerIds.length * NODE_WIDTH + (layerIds.length - 1) * X_GAP;
    let startX = -totalWidth / 2 + NODE_WIDTH / 2;
    const y = d * (NODE_HEIGHT + Y_GAP);
    for (let i = 0; i < layerIds.length; i++) {
      positions.set(layerIds[i]!, { x: startX + i * (NODE_WIDTH + X_GAP), y });
    }
  }

  // 计算每行的 X 边界（用骨干位置）——flank 必须放在整行外，避免和同层兄弟重叠
  const rowBounds = new Map<number, { minX: number; maxX: number }>();
  for (const id of backbone.ids) {
    const pos = positions.get(id);
    if (!pos) continue;
    const cur = rowBounds.get(pos.y);
    if (cur) {
      cur.minX = Math.min(cur.minX, pos.x);
      cur.maxX = Math.max(cur.maxX, pos.x);
    } else {
      rowBounds.set(pos.y, { minX: pos.x, maxX: pos.x });
    }
  }

  // 占位计数器（按 anchor + 类别）
  const flankCount = new Map<string, number>();
  const bumpFlank = (key: string) => {
    const c = (flankCount.get(key) ?? 0) + 1;
    flankCount.set(key, c);
    return c - 1;
  };
  const FLANK_STEP_Y = NODE_HEIGHT + 30;

  // 焦点卡若是外部（不在 backbone）—— 给它一个位置（贴在与它有边的某张 backbone 卡旁边），
  // 这样它就能作为 tag-related 节点的锚，避免堆叠
  if (rawNodes.has(focusedCardId) && !positions.has(focusedCardId)) {
    // 找它与 backbone 之间的边（cross/tag 都行）
    const bridge = rawEdges.find(
      (e) =>
        (e.source === focusedCardId && backbone.ids.has(e.target)) ||
        (e.target === focusedCardId && backbone.ids.has(e.source)),
    );
    const anchorBackbone = bridge
      ? (backbone.ids.has(bridge.source) ? bridge.source : bridge.target)
      : [...backbone.ids][0];
    if (anchorBackbone) {
      const anchor = positions.get(anchorBackbone);
      if (anchor) {
        // 放在 anchor 右侧第一个 flank 槽位
        positions.set(focusedCardId, {
          x: anchor.x + NODE_WIDTH + FLANK_OFFSET_X,
          y: anchor.y,
        });
        // 占用 anchor 右侧第一个槽位计数
        bumpFlank(`${anchorBackbone}::R`);
        // 更新 row bounds 让后续 flank 算的时候知道焦点占了位置
        const row = rowBounds.get(anchor.y);
        if (row) row.maxX = Math.max(row.maxX, anchor.x + NODE_WIDTH + FLANK_OFFSET_X);
      }
    }
  }

  // 为每个待定位节点找它"挂在哪张已定位的卡上"。
  // 锚候选 = backbone ∪ {focusedCardId}（焦点是外部卡时它也是合法锚）
  const anchorCandidates = new Set<string>(backbone.ids);
  if (positions.has(focusedCardId)) anchorCandidates.add(focusedCardId);
  const findAnchor = (id: string) => {
    const edge = rawEdges.find(
      (e) =>
        (e.source === id && anchorCandidates.has(e.target)) ||
        (e.target === id && anchorCandidates.has(e.source)),
    );
    if (!edge) return null;
    return anchorCandidates.has(edge.source) ? edge.source : edge.target;
  };

  // Pass 1: cross-flanks 和 tag-related 一起布局（同等"侧翼"地位），左右交替
  for (const [id, data] of rawNodes) {
    if (positions.has(id)) continue;
    if (data.variant !== 'cross-flank' && data.variant !== 'tag-related') continue;
    const anchorId = findAnchor(id);
    if (!anchorId) {
      positions.set(id, { x: 1500, y: -500 });
      continue;
    }
    const anchor = positions.get(anchorId)!;
    const row = rowBounds.get(anchor.y) ?? { minX: anchor.x, maxX: anchor.x };

    const leftIdx = flankCount.get(`${anchorId}::L`) ?? 0;
    const rightIdx = flankCount.get(`${anchorId}::R`) ?? 0;
    if (leftIdx <= rightIdx) {
      const i = bumpFlank(`${anchorId}::L`);
      positions.set(id, {
        x: row.minX - NODE_WIDTH - FLANK_OFFSET_X,
        y: anchor.y + i * FLANK_STEP_Y,
      });
    } else {
      const i = bumpFlank(`${anchorId}::R`);
      positions.set(id, {
        x: row.maxX + NODE_WIDTH + FLANK_OFFSET_X,
        y: anchor.y + i * FLANK_STEP_Y,
      });
    }
  }

  // Pass 2: potential（含 ws-temp ghost）
  // —— 紧贴被链接的卡片放，但要让出已存在的右侧 cross-flank 位置
  for (const [id, data] of rawNodes) {
    if (positions.has(id)) continue;
    if (data.variant !== 'potential') continue;
    const anchorId = findAnchor(id);
    if (!anchorId) {
      positions.set(id, { x: 1500, y: -500 });
      continue;
    }
    const anchor = positions.get(anchorId)!;
    const row = rowBounds.get(anchor.y) ?? { minX: anchor.x, maxX: anchor.x };

    const i = bumpFlank(`${anchorId}::pot`);
    const rightCrossCount = flankCount.get(`${anchorId}::R`) ?? 0;
    // 没有右侧 cross-flank → potential 直接占行边界外的第一个槽位
    // 有右侧 cross-flank → potential 退到 cross-flank 之后
    const xOffset =
      rightCrossCount > 0
        ? 2 * (NODE_WIDTH + FLANK_OFFSET_X) + POTENTIAL_OFFSET_X
        : NODE_WIDTH + FLANK_OFFSET_X + POTENTIAL_OFFSET_X;
    positions.set(id, {
      x: row.maxX + xOffset,
      y: anchor.y + i * FLANK_STEP_Y,
    });
  }

  // Pass 3: 兜底（不应触达，但 focus / tree 漏了的话不至于崩）
  for (const [id] of rawNodes) {
    if (positions.has(id)) continue;
    positions.set(id, { x: 1500, y: -500 });
  }

  /* ----- 4. 边：智能 handle 选择 ----- */
  const edgeStyles: Record<RawEdgeKind, { stroke: string; strokeWidth: number; strokeDasharray?: string }> = {
    tree: { stroke: '#9ca3af', strokeWidth: 1.5 },
    cross: { stroke: '#7c4dff', strokeWidth: 1.3 },
    tag: { stroke: '#10b981', strokeWidth: 1.4 }, // 绿色实线，first-class
    potential: { stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '6 4' },
  };

  const pickHandles = (
    kind: RawEdgeKind,
    src: { x: number; y: number },
    tgt: { x: number; y: number },
  ): { sourceHandle: string; targetHandle: string } => {
    if (kind === 'tree') {
      return { sourceHandle: 'bottom', targetHandle: 'top' };
    }
    // 非树：避免"圆圈"——两卡横向距离很小时，应该走上下，不要走左右
    const dx = tgt.x - src.x;
    const dy = tgt.y - src.y;
    if (Math.abs(dx) < NODE_WIDTH * 0.6) {
      return dy > 0
        ? { sourceHandle: 'bottom', targetHandle: 'top' }
        : { sourceHandle: 'top', targetHandle: 'bottom' };
    }
    return dx > 0
      ? { sourceHandle: 'right-out', targetHandle: 'left-in' }
      : { sourceHandle: 'left-out', targetHandle: 'right-in' };
  };

  const nodes: Node[] = Array.from(rawNodes.entries()).map(([id, data]) => {
    const pos = positions.get(id) ?? { x: 0, y: 0 };
    return {
      id,
      type: 'card',
      data: data as unknown as Record<string, unknown>,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      width: NODE_WIDTH,
    };
  });

  // 跟踪每个 (target, handle) 已经被几条 ws 边占用 → 多条时轮换 handle 避免重叠
  const targetHandleCount = new Map<string, number>();
  const sourceHandleCount = new Map<string, number>();
  const targetRotation = ['left-in', 'top', 'right-in', 'bottom'];
  const sourceRotation = ['right-out', 'bottom', 'left-out', 'top'];

  const edges: Edge[] = rawEdges.map((e) => {
    const src = positions.get(e.source);
    const tgt = positions.get(e.target);
    let { sourceHandle, targetHandle } =
      src && tgt
        ? pickHandles(e.kind, src, tgt)
        : { sourceHandle: 'bottom' as string, targetHandle: 'top' as string };

    // ws 边（id 以 ws: 开头）：多条到同一节点时轮换 handle
    if (e.id.startsWith('ws:')) {
      const tgtKey = `${e.target}:${targetHandle}`;
      const tgtUsed = targetHandleCount.get(tgtKey) ?? 0;
      if (tgtUsed > 0) {
        targetHandle = targetRotation[tgtUsed % targetRotation.length]!;
      }
      targetHandleCount.set(tgtKey, tgtUsed + 1);

      const srcKey = `${e.source}:${sourceHandle}`;
      const srcUsed = sourceHandleCount.get(srcKey) ?? 0;
      if (srcUsed > 0) {
        sourceHandle = sourceRotation[srcUsed % sourceRotation.length]!;
      }
      sourceHandleCount.set(srcKey, srcUsed + 1);
    }

    // 焦点卡的连线加粗 + 不透明度满，让用户切焦点时一眼看到关联。
    // 不触焦点的边大幅淡化（0.18） + 比基础再细一档 —— 用户反馈 0.6 还是太抢戏。
    // tree 边稍特殊：哪怕不触焦点也保留较高 opacity（0.5），不然结构感会断。
    const touchesFocus = e.source === focusedCardId || e.target === focusedCardId;
    const baseStyle = edgeStyles[e.kind];
    let style: { stroke: string; strokeWidth: number; strokeDasharray?: string; opacity: number };
    if (touchesFocus) {
      style = { ...baseStyle, strokeWidth: baseStyle.strokeWidth + 1.5, opacity: 1 };
    } else if (e.kind === 'tree') {
      style = { ...baseStyle, opacity: 0.5 };
    } else {
      style = { ...baseStyle, strokeWidth: Math.max(0.8, baseStyle.strokeWidth - 0.3), opacity: 0.18 };
    }
    // potential / cross 用自定义 edge type（带中点 link/unlink 按钮），其余 bezier
    const type =
      e.kind === 'potential' ? 'potential' : e.kind === 'cross' ? 'cross' : 'default';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle,
      targetHandle,
      type,
      animated: false,
      style,
      data: { kind: e.kind, touchesFocus, isWsLink: e.isWsLink ?? false },
    };
  });

  return { nodes, edges };
}

/**
 * 用用户保存的"锚点"位置覆盖计算位置。
 *   规则：
 *     1. variant 是 'potential' → **永远用计算位置**（potential 卡作为"客串"出现，不应继承别处的锚点）
 *     2. 节点本身有 saved → 用 saved
 *     3. 节点无 saved，但 tree 父链上有 saved 锚点 → 沿父的锚点位置 + 计算时的偏移
 *     4. 都无 → 用计算位置
 *   这样新加的卡如果父被手动移过，它会跟随父的位置生长。
 */
export function applyAnchorPositions(
  nodes: Node[],
  edges: Edge[],
  saved: PositionMap,
): Node[] {
  const computedPos = new Map(nodes.map((n) => [n.id, n.position]));
  const variantById = new Map(
    nodes.map((n) => [n.id, (n.data as unknown as CardNodeData | undefined)?.variant]),
  );
  // tree 父：source → target 的 tree 边里，target 的父是 source
  const treeParent = new Map<string, string>();
  for (const e of edges) {
    const kind = (e.data as { kind?: string } | undefined)?.kind;
    if (kind === 'tree') treeParent.set(e.target, e.source);
  }

  const final = new Map<string, { x: number; y: number }>();

  const resolve = (id: string): { x: number; y: number } => {
    const cached = final.get(id);
    if (cached) return cached;
    const own = computedPos.get(id) ?? { x: 0, y: 0 };

    // potential 永远用计算位置，不读取也不继承锚点
    if (variantById.get(id) === 'potential') {
      final.set(id, own);
      return own;
    }

    if (saved[id]) {
      final.set(id, saved[id]);
      return saved[id];
    }
    const parent = treeParent.get(id);
    if (!parent) {
      final.set(id, own);
      return own;
    }
    const parentFinal = resolve(parent);
    const parentComputed = computedPos.get(parent);
    if (!parentComputed) {
      final.set(id, own);
      return own;
    }
    // 沿父的锚点位置 + 计算时的相对偏移
    const p = {
      x: parentFinal.x + (own.x - parentComputed.x),
      y: parentFinal.y + (own.y - parentComputed.y),
    };
    final.set(id, p);
    return p;
  };

  return nodes.map((n) => {
    const sav = saved[n.id];
    const data = n.data as Record<string, unknown> & {
      savedW?: number;
      savedH?: number;
    };
    return {
      ...n,
      position: resolve(n.id),
      // 让 React Flow 知道实际尺寸，避免 fitView / 其他卡片把它压到默认大小
      width: sav?.w ?? (n.width as number | undefined),
      height: sav?.h ?? undefined,
      data: {
        ...data,
        savedW: sav?.w,
        savedH: sav?.h,
      },
    };
  });
}

/**
 * 简单的"碰撞力"——AABB 反推。
 *   - 用户手动拖过保存了位置的卡 → 视为锁定，不会被推动
 *   - 其它卡互相碰撞时沿最小重叠轴推开
 *   - 默认 60 次迭代或所有对都不再重叠时停止
 *   - 给周围加 padding，让相邻的卡有呼吸空间
 *
 * 这不是真正的物理仿真（不需要每帧跑），只是布局阶段一次性把重叠抹掉。
 */
export function resolveCollisions(
  nodes: Node[],
  saved: PositionMap,
  padding = 24,
  maxIterations = 60,
): Node[] {
  if (nodes.length < 2) return nodes;

  type Box = { x: number; y: number; w: number; h: number; fixed: boolean };
  const boxes = new Map<string, Box>();
  for (const n of nodes) {
    const sav = saved[n.id];
    const dataW = (n.data as { savedW?: number } | undefined)?.savedW;
    const dataH = (n.data as { savedH?: number } | undefined)?.savedH;
    boxes.set(n.id, {
      x: n.position.x,
      y: n.position.y,
      w: sav?.w ?? dataW ?? (n.width as number | undefined) ?? NODE_WIDTH,
      h: sav?.h ?? dataH ?? NODE_HEIGHT,
      fixed: !!sav, // 用户保存了 → 锁定
    });
  }

  const ids = nodes.map((n) => n.id);
  for (let iter = 0; iter < maxIterations; iter++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      const a = boxes.get(ids[i]!)!;
      for (let j = i + 1; j < ids.length; j++) {
        const b = boxes.get(ids[j]!)!;
        if (a.fixed && b.fixed) continue;

        const acx = a.x + a.w / 2;
        const acy = a.y + a.h / 2;
        const bcx = b.x + b.w / 2;
        const bcy = b.y + b.h / 2;
        const dx = bcx - acx;
        const dy = bcy - acy;
        const overlapX = (a.w + b.w) / 2 + padding - Math.abs(dx);
        const overlapY = (a.h + b.h) / 2 + padding - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        // 沿重叠较小的轴推开
        const aShare = a.fixed ? 0 : b.fixed ? 1 : 0.5;
        const bShare = b.fixed ? 0 : a.fixed ? 1 : 0.5;

        if (overlapX < overlapY) {
          const sign = dx >= 0 ? 1 : -1;
          a.x -= sign * overlapX * aShare;
          b.x += sign * overlapX * bShare;
        } else {
          const sign = dy >= 0 ? 1 : -1;
          a.y -= sign * overlapY * aShare;
          b.y += sign * overlapY * bShare;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  return nodes.map((n) => {
    const box = boxes.get(n.id)!;
    return { ...n, position: { x: box.x, y: box.y } };
  });
}

/* -------- TagView 用的图：以 tag 为虚拟根，卡片按自然树扩展 -------- */

export const TAG_ROOT_PREFIX = '__tag::';

export function buildTagGraph(tag: string, cards: Card[]): { nodes: Node[]; edges: Edge[] } {
  const tagRootId = `${TAG_ROOT_PREFIX}${tag}`;
  const sorted = [...cards].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const inSet = new Set(sorted.map((c) => c.luhmannId));

  // 用 dagre 算 TB 树形布局
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',
    nodesep: 80,
    ranksep: 130,
    marginx: 60,
    marginy: 60,
    align: 'UL',
  });
  g.setDefaultEdgeLabel(() => ({}));

  // tag-root 节点（虚拟，体积小）
  const TAG_ROOT_W = 220;
  const TAG_ROOT_H = 90;
  g.setNode(tagRootId, { width: TAG_ROOT_W, height: TAG_ROOT_H });
  // 卡片节点
  for (const c of sorted) {
    g.setNode(c.luhmannId, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  // tree edges：折叠到 Folgezettel 父（如果父在集合内），否则连到 tag-root
  type RawEdge = { source: string; target: string; kind: 'tree' | 'cross' };
  const rawEdges: RawEdge[] = [];
  for (const c of sorted) {
    const parent = deriveParentId(c.luhmannId);
    if (parent && inSet.has(parent)) {
      rawEdges.push({ source: parent, target: c.luhmannId, kind: 'tree' });
      g.setEdge(parent, c.luhmannId, { weight: 4 });
    } else {
      rawEdges.push({ source: tagRootId, target: c.luhmannId, kind: 'tree' });
      g.setEdge(tagRootId, c.luhmannId, { weight: 4 });
    }
  }

  // cross edges：手动 [[link]] 在集合内的（不参与布局，但显示）
  for (const c of sorted) {
    for (const target of c.crossLinks) {
      if (inSet.has(target) && target !== c.luhmannId) {
        rawEdges.push({ source: c.luhmannId, target, kind: 'cross' });
      }
    }
  }

  dagre.layout(g);

  // 节点
  const tagRootPos = g.node(tagRootId);
  const nodes: Node[] = [
    {
      id: tagRootId,
      type: 'tag-root',
      data: { tag } as unknown as Record<string, unknown>,
      position: {
        x: tagRootPos.x - TAG_ROOT_W / 2,
        y: tagRootPos.y - TAG_ROOT_H / 2,
      },
      width: TAG_ROOT_W,
    },
    ...sorted.map((c) => {
      const pos = g.node(c.luhmannId);
      return {
        id: c.luhmannId,
        type: 'card' as const,
        data: { card: c, variant: 'tree' as const } as unknown as Record<string, unknown>,
        position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
        width: NODE_WIDTH,
      };
    }),
  ];

  // 边
  const edges: Edge[] = rawEdges.map((e, i) => {
    if (e.kind === 'tree') {
      return {
        id: `tree:${e.source}->${e.target}-${i}`,
        source: e.source,
        target: e.target,
        sourceHandle: 'bottom',
        targetHandle: 'top',
        type: 'default',
        style: { stroke: '#9ca3af', strokeWidth: 1.5 },
        data: { kind: 'tree' },
      };
    }
    // cross：智能选 handle 避免圆圈
    const srcPos = g.node(e.source);
    const tgtPos = g.node(e.target);
    const dx = tgtPos.x - srcPos.x;
    const dy = tgtPos.y - srcPos.y;
    let sourceHandle: string;
    let targetHandle: string;
    if (Math.abs(dx) < NODE_WIDTH * 0.6) {
      sourceHandle = dy > 0 ? 'bottom' : 'top';
      targetHandle = dy > 0 ? 'top' : 'bottom';
    } else if (dx > 0) {
      sourceHandle = 'right-out';
      targetHandle = 'left-in';
    } else {
      sourceHandle = 'left-out';
      targetHandle = 'right-in';
    }
    return {
      id: `cross:${e.source}->${e.target}-${i}`,
      source: e.source,
      target: e.target,
      sourceHandle,
      targetHandle,
      type: 'default',
      style: { stroke: '#7c4dff', strokeWidth: 1.3 },
      data: { kind: 'cross' },
    };
  });

  return { nodes, edges };
}
