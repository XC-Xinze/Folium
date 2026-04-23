import type Database from 'better-sqlite3';
import type { Card, CardSummary, PotentialLink, ReferencedFromHit } from '../types.js';
import type { CardRepository } from '../vault/repository.js';

export interface TagRelated {
  luhmannId: string;
  title: string;
  sharedTags: string[];
  jaccard: number;
}

/**
 * 找出 source 卡片正文中包含 [[targetId]] 或 [[target.title]] 的段落。
 * 段落以连续两个换行划分。
 */
function findReferringParagraph(sourceMd: string, targetId: string, targetTitle: string): string | null {
  const paragraphs = sourceMd.split(/\n{2,}/);
  const idRe = new RegExp(`\\[\\[\\s*${escapeRe(targetId)}(?:\\|[^\\]]+)?\\s*\\]\\]`, 'i');
  const titleRe = new RegExp(`\\[\\[\\s*${escapeRe(targetTitle)}(?:\\|[^\\]]+)?\\s*\\]\\]`, 'i');
  for (const p of paragraphs) {
    if (idRe.test(p) || titleRe.test(p)) return p.trim();
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getLinkedCards(repo: CardRepository, card: Card): Card[] {
  return card.crossLinks
    .map((id) => repo.getById(id))
    .filter((c): c is Card => c !== null);
}

export function getReferencedFrom(
  db: Database.Database,
  repo: CardRepository,
  card: Card,
): ReferencedFromHit[] {
  const sourceIds = (db
    .prepare(`SELECT source_id FROM cross_links WHERE target_id = ?`)
    .all(card.luhmannId) as { source_id: string }[]).map((r) => r.source_id);

  const hits: ReferencedFromHit[] = [];
  for (const sid of sourceIds) {
    const source = repo.getById(sid);
    if (!source) continue;
    const para = findReferringParagraph(source.contentMd, card.luhmannId, card.title);
    hits.push({
      sourceId: source.luhmannId,
      sourceTitle: source.title,
      paragraph: para ?? source.contentMd.slice(0, 200),
    });
  }
  return hits;
}

/**
 * Tag 共现：和当前卡片共享标签的所有卡片。
 * 这是"涌现的化学反应"——不是潜在建议，而是一等的可视关系。
 * 不与 Potential 混在一起。
 */
export function getTagRelated(
  db: Database.Database,
  repo: CardRepository,
  card: Card,
): TagRelated[] {
  if (card.tags.length === 0) return [];
  const placeholders = card.tags.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT luhmann_id, GROUP_CONCAT(tag) AS shared_csv, COUNT(*) AS shared
       FROM card_tags
       WHERE tag IN (${placeholders}) AND luhmann_id != ?
       GROUP BY luhmann_id
       ORDER BY shared DESC`,
    )
    .all(...card.tags, card.luhmannId) as { luhmann_id: string; shared_csv: string; shared: number }[];

  const out: TagRelated[] = [];
  for (const row of rows) {
    const c = repo.getById(row.luhmann_id);
    if (!c) continue;
    const otherTagCount = (db
      .prepare(`SELECT COUNT(*) as n FROM card_tags WHERE luhmann_id = ?`)
      .get(row.luhmann_id) as { n: number }).n;
    const union = card.tags.length + otherTagCount - row.shared;
    const jaccard = union > 0 ? row.shared / union : 0;
    out.push({
      luhmannId: c.luhmannId,
      title: c.title,
      sharedTags: row.shared_csv.split(','),
      jaccard: Number(jaccard.toFixed(3)),
    });
  }
  return out;
}

/**
 * 潜在链接：纯文本/关键字层面的发现，未来可能加 embedding 等技术。
 * 与 tag 完全无关——tag 是 first-class，走 getTagRelated。
 *
 * 当前两种信号：
 *   1. FTS5 全文 BM25（标题作为 query）
 *   2. 标题/编号在他人正文中的明文出现（Logseq 风格）
 */
export function getPotentialLinks(
  db: Database.Database,
  repo: CardRepository,
  card: Card,
  limit = 10,
): PotentialLink[] {
  // tag 共现的卡片也排除掉，避免和"已经因 tag 显示"的卡片重复
  const tagRelatedIds = new Set(getTagRelated(db, repo, card).map((t) => t.luhmannId));
  const excluded = new Set<string>([card.luhmannId, ...card.crossLinks, ...tagRelatedIds]);

  const scores = new Map<string, { score: number; reasons: Set<string> }>();
  const bump = (id: string, delta: number, reason: string) => {
    if (excluded.has(id)) return;
    const cur = scores.get(id) ?? { score: 0, reasons: new Set<string>() };
    cur.score += delta;
    cur.reasons.add(reason);
    scores.set(id, cur);
  };

  // 信号 1：FTS5 BM25
  try {
    const ftsQuery = sanitizeFtsQuery(card.title);
    if (ftsQuery) {
      const rows = db
        .prepare(
          `SELECT luhmann_id, bm25(cards_fts) AS rank
           FROM cards_fts
           WHERE cards_fts MATCH ?
           ORDER BY rank LIMIT 30`,
        )
        .all(ftsQuery) as { luhmann_id: string; rank: number }[];
      for (const row of rows) {
        const norm = 1 / (1 + Math.max(0, row.rank));
        bump(row.luhmann_id, norm * 0.6, 'content similarity');
      }
    }
  } catch {
    // FTS query 失败（保留字符等）静默忽略
  }

  // 信号 2：当前卡片的 luhmannId / title 在他人正文中的明文出现
  const mentionRows = db
    .prepare(
      `SELECT luhmann_id FROM cards
       WHERE luhmann_id != ?
         AND (content_md LIKE '%' || ? || '%' OR content_md LIKE '%' || ? || '%')`,
    )
    .all(card.luhmannId, card.luhmannId, card.title) as { luhmann_id: string }[];
  for (const row of mentionRows) {
    bump(row.luhmann_id, 0.5, 'mentioned in body');
  }

  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([id, v]) => {
      const c = repo.getById(id);
      return c
        ? {
            luhmannId: c.luhmannId,
            title: c.title,
            score: Number(v.score.toFixed(3)),
            reasons: [...v.reasons],
          }
        : null;
    })
    .filter((x): x is PotentialLink => x !== null);
}

// CardSummary unused but type imported for future tag-related list
void (null as unknown as CardSummary);

function sanitizeFtsQuery(s: string): string {
  // 去掉 FTS5 保留字符，只保留中英文/数字
  const tokens = s
    .replace(/["()*:^]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  return tokens.map((t) => `"${t}"`).join(' OR ');
}
