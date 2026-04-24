import type Database from 'better-sqlite3';
import type { CardRepository } from '../vault/repository.js';
import { getPotentialLinks } from './links.js';

/**
 * 发现 vault 里"看起来是同一类，但没被任何 INDEX 收"的卡片簇。
 *
 * 算法：
 *   1. 对每张 ATOMIC 卡，拿前 10 个 potential link（文本/裸提及/FTS）
 *   2. 如果 A 在 B 的 potential 里 AND B 在 A 的 potential 里 → 互相算"邻居"
 *   3. 在邻居图上找连通分量
 *   4. 过滤：大小 ≥ 3 + 不是某个现有 INDEX 的子集
 *
 * 返回的簇可以拿去建新 INDEX 卡，或者打共同 tag。
 */

export interface DiscoveryCluster {
  /** 簇内卡片 id 列表 */
  cards: { luhmannId: string; title: string }[];
  /** 高频共享 tag（如果有 → 暗示这个簇可能就是某个主题） */
  hintTags: string[];
}

const MIN_CLUSTER_SIZE = 3;
const MAX_POTENTIAL_LOOKUP = 10;

export function findDiscoveryClusters(
  db: Database.Database,
  repo: CardRepository,
): DiscoveryCluster[] {
  const allCards = repo.list();
  const cardById = new Map(allCards.map((c) => [c.luhmannId, c]));

  // 1) 为每张 ATOMIC 卡缓存 potential 邻居 id 集合
  const potentialOf = new Map<string, Set<string>>();
  for (const c of allCards) {
    if (c.status === 'INDEX') continue;
    const pot = getPotentialLinks(db, repo, c, MAX_POTENTIAL_LOOKUP);
    potentialOf.set(c.luhmannId, new Set(pot.map((p) => p.luhmannId)));
  }

  // 2) 互相邻接图
  const adj = new Map<string, Set<string>>();
  for (const [a, aPot] of potentialOf) {
    for (const b of aPot) {
      const bPot = potentialOf.get(b);
      if (!bPot || !bPot.has(a)) continue;
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    }
  }

  // 3) 连通分量（BFS）
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const node of adj.keys()) {
    if (visited.has(node)) continue;
    const comp: string[] = [];
    const queue = [node];
    visited.add(node);
    while (queue.length) {
      const cur = queue.shift()!;
      comp.push(cur);
      for (const n of adj.get(cur) ?? []) {
        if (!visited.has(n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
    if (comp.length >= MIN_CLUSTER_SIZE) components.push(comp);
  }

  // 4) 过滤：是某 INDEX 完全子集的不算"未发现"
  const indexMembers = allCards
    .filter((c) => c.status === 'INDEX')
    .map((c) => new Set(c.crossLinks));
  const novelComps = components.filter(
    (comp) => !indexMembers.some((members) => comp.every((id) => members.has(id))),
  );

  // 5) 算每个簇的高频共享 tag
  return novelComps.map((comp) => {
    const tagFreq = new Map<string, number>();
    for (const id of comp) {
      const c = cardById.get(id);
      if (!c) continue;
      for (const t of c.tags) tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
    }
    const hintTags = [...tagFreq.entries()]
      .filter(([_, n]) => n >= Math.ceil(comp.length / 2))
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t)
      .slice(0, 3);
    return {
      cards: comp.map((id) => {
        const c = cardById.get(id)!;
        return { luhmannId: c.luhmannId, title: c.title };
      }),
      hintTags,
    };
  });
}
