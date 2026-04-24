import type Database from 'better-sqlite3';

/**
 * 动态索引：INDEX 卡正文里写一行 HTML 注释指令，指明"按规则收成员"。
 *
 * 语法：`<!-- @members tag:foo -->` 或 `<!-- @members tag:foo,bar -->` (OR)
 * 多个指令可以叠加（取并集）。
 *
 * 例：
 *   <!-- @members tag:机器学习 -->
 *   <!-- @members tag:深度学习,nlp -->
 */

const DIRECTIVE_RE = /<!--\s*@members\s+([^-]+?)\s*-->/g;

/** 解析正文里的所有 @members 指令，返回查询条件列表 */
export function parseQueries(contentMd: string): { tags: string[] }[] {
  const queries: { tags: string[] }[] = [];
  let m: RegExpExecArray | null;
  DIRECTIVE_RE.lastIndex = 0;
  while ((m = DIRECTIVE_RE.exec(contentMd)) !== null) {
    const body = m[1]!.trim();
    // 仅支持 tag:xxx 形式（v1）
    const tagMatch = body.match(/^tag:(.+)$/);
    if (tagMatch) {
      const tags = tagMatch[1]!
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      if (tags.length > 0) queries.push({ tags });
    }
  }
  return queries;
}

/** 跑指令拿到匹配的 luhmannId 集合（已去掉自己） */
export function runQueries(
  db: Database.Database,
  selfId: string,
  queries: { tags: string[] }[],
): string[] {
  if (queries.length === 0) return [];
  const matched = new Set<string>();
  for (const q of queries) {
    if (q.tags.length === 0) continue;
    const placeholders = q.tags.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT DISTINCT luhmann_id FROM card_tags
         WHERE tag IN (${placeholders}) AND luhmann_id != ?`,
      )
      .all(...q.tags, selfId) as { luhmann_id: string }[];
    for (const r of rows) matched.add(r.luhmann_id);
  }
  return [...matched];
}

/** 综合：解析正文 + 跑查询 + 返回自动成员 */
export function getDynamicMembers(
  db: Database.Database,
  selfId: string,
  contentMd: string,
): string[] {
  const queries = parseQueries(contentMd);
  return runQueries(db, selfId, queries);
}
