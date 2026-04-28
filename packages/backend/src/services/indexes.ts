import type Database from 'better-sqlite3';
import type { CardRepository } from '../vault/repository.js';

export interface IndexNode {
  luhmannId: string;
  title: string;
  status: 'ATOMIC' | 'INDEX';
  children: IndexNode[];
}

/**
 * 构建索引树：
 *  - INDEX = derived from structure（顶层卡或有任何 Folgezettel 子卡 → 它就是 INDEX）
 *  - 顶层 = INDEX 且没有被任何其他 INDEX 通过 crossLinks 引用的卡
 *  - 子节点 = 当前 INDEX 通过 cross_links 引用的所有卡（INDEX 继续递归，其他做叶子）
 *  - 防环：访问过的节点不再展开
 */
export function buildIndexTree(db: Database.Database, repo: CardRepository): IndexNode[] {
  // status 不再存在 cards.status 列里，改成派生：
  // - parent_id IS NULL 的顶层卡天然是 INDEX / 大盒子
  // - 被任何卡当 parent_id 的卡也是 INDEX
  const allIndexes = (db
    .prepare(
      `SELECT luhmann_id FROM cards WHERE parent_id IS NULL
       UNION
       SELECT DISTINCT parent_id AS luhmann_id FROM cards WHERE parent_id IS NOT NULL`,
    )
    .all() as { luhmann_id: string }[]).map((r) => r.luhmann_id);

  const indexSet = new Set(allIndexes);

  // 找出"被其他 INDEX 引用过的 INDEX 卡"——它们是子索引，不是顶层
  const childIndexes = new Set<string>();
  for (const idx of allIndexes) {
    const refs = (db
      .prepare(`SELECT target_id FROM cross_links WHERE source_id = ?`)
      .all(idx) as { target_id: string }[]).map((r) => r.target_id);
    for (const target of refs) {
      if (indexSet.has(target)) childIndexes.add(target);
    }
  }
  const topLevelIndexes = allIndexes.filter((id) => !childIndexes.has(id));

  const visited = new Set<string>();
  const buildNode = (id: string): IndexNode | null => {
    if (visited.has(id)) return null; // 防环
    visited.add(id);
    const card = repo.getById(id);
    if (!card) return null;
    const childIds = (db
      .prepare(`SELECT target_id FROM cross_links WHERE source_id = ?`)
      .all(id) as { target_id: string }[]).map((r) => r.target_id);
    const children: IndexNode[] = [];
    for (const cid of childIds) {
      const c = repo.getById(cid);
      if (!c) continue;
      if (c.status === 'INDEX') {
        const sub = buildNode(cid);
        if (sub) children.push(sub);
      } else {
        children.push({
          luhmannId: c.luhmannId,
          title: c.title,
          status: c.status,
          children: [],
        });
      }
    }
    return {
      luhmannId: card.luhmannId,
      title: card.title,
      status: card.status,
      children,
    };
  };

  return topLevelIndexes
    .map(buildNode)
    .filter((n): n is IndexNode => n !== null);
}
