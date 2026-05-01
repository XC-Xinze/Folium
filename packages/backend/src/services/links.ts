import type Database from 'better-sqlite3';
import type { Card, CardSummary, PotentialLink, ReferencedFromHit } from '../types.js';
import type { CardRepository } from '../vault/repository.js';

export interface TagRelated {
  luhmannId: string;
  title: string;
  sharedTags: string[];
  jaccard: number;
}

const MIN_POTENTIAL_SCORE = 0.55;
const MIN_SHARED_CONTENT_KEYWORDS = 3;

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
 * 潜在链接（Logseq 风的 "Unlinked References"）：
 *   不需要双向链接，只要正文里出现了别人的标题/编号（不在 [[...]] 包裹内）就算。
 *
 *   三种信号：
 *     1. incoming — 别人正文里以纯文本形式提到了"我"
 *     2. outgoing — "我"的正文里以纯文本形式提到了别人
 *     3. FTS5 BM25 全文相似度（兜底信号）
 *
 *   tag 共现 / 已有 [[link]] 的卡片排除，避免和其他视觉层重复。
 */
export function getPotentialLinks(
  db: Database.Database,
  repo: CardRepository,
  card: Card,
  limit = 10,
): PotentialLink[] {
  const tagRelatedIds = new Set(getTagRelated(db, repo, card).map((t) => t.luhmannId));
  const excluded = new Set<string>([card.luhmannId, ...card.crossLinks, ...tagRelatedIds]);

  const scores = new Map<string, { score: number; reasons: Set<string> }>();
  const bump = (id: string, delta: number, reason: string) => {
    if (excluded.has(id)) return;
    const candidate = repo.getById(id);
    if (!candidate || candidate.status === 'INDEX') return;
    const cur = scores.get(id) ?? { score: 0, reasons: new Set<string>() };
    cur.score += delta;
    cur.reasons.add(reason);
    scores.set(id, cur);
  };

  const myKeywords = titleKeywords(card.title);

  // ── 信号 0: title ↔ title —— 标题层面相互包含/重叠 ──
  const titleRows = db
    .prepare(`SELECT luhmann_id, title FROM cards WHERE luhmann_id != ? AND status != 'INDEX'`)
    .all(card.luhmannId) as { luhmann_id: string; title: string }[];
  for (const other of titleRows) {
    if (excluded.has(other.luhmann_id)) continue;
    const otherKeywords = titleKeywords(other.title);
    let total = 0;
    for (const kw of myKeywords) total += countUnlinkedHits(other.title, kw);
    for (const kw of otherKeywords) total += countUnlinkedHits(card.title, kw);
    if (total > 0) {
      bump(other.luhmann_id, Math.min(total * 0.6, 1.2), `title overlap ×${total}`);
    }
  }

  // ── 信号 1: incoming —— 谁的正文里以纯文本形式提到了"我"？ ──
  // 不仅匹配完整标题，还匹配标题切片（"主动学习与查询策略" → 同时试 "主动学习" / "查询策略"）。
  const allCardsWithContent = db
    .prepare(`SELECT luhmann_id, content_md FROM cards WHERE luhmann_id != ? AND status != 'INDEX'`)
    .all(card.luhmannId) as { luhmann_id: string; content_md: string }[];
  for (const row of allCardsWithContent) {
    if (excluded.has(row.luhmann_id)) continue;
    const stripped = stripPotentialNoise(row.content_md);
    let total = 0;
    for (const kw of myKeywords) total += countUnlinkedHits(stripped, kw);
    total += countUnlinkedHits(stripped, card.luhmannId);
    if (total > 0) {
      bump(row.luhmann_id, Math.min(total * 0.7, 1.5), `mentions this card ×${total}`);
    }
  }

  // ── 信号 2: outgoing —— "我"的正文里以纯文本形式提到了别人？ ──
  const myStripped = stripPotentialNoise(card.contentMd);
  const allOthers = db
    .prepare(`SELECT luhmann_id, title FROM cards WHERE luhmann_id != ? AND status != 'INDEX'`)
    .all(card.luhmannId) as { luhmann_id: string; title: string }[];
  for (const other of allOthers) {
    if (excluded.has(other.luhmann_id)) continue;
    let total = 0;
    for (const kw of titleKeywords(other.title)) {
      total += countUnlinkedHits(myStripped, kw);
    }
    total += countUnlinkedHits(myStripped, other.luhmann_id);
    if (total > 0) {
      bump(other.luhmann_id, Math.min(total * 0.7, 1.4), `mentioned here ×${total}`);
    }
  }

  // ── 信号 3: FTS5 BM25 正文相似度（兜底） ──
  // 用正文关键词，而不是只拿标题去撞全库，避免退化成"正文匹配某个 index 名称"。
  try {
    const sourceContentKeywords = contentKeywords(card.contentMd);
    const ftsQuery = sanitizeFtsQuery(sourceContentKeywords.slice(0, 12).join(' '));
    if (ftsQuery) {
      const rows = db
        .prepare(
          `SELECT luhmann_id, content_md, bm25(cards_fts) AS rank
           FROM cards_fts
           WHERE cards_fts MATCH ?
           ORDER BY rank LIMIT 30`,
        )
        .all(ftsQuery) as { luhmann_id: string; content_md: string; rank: number }[];
      for (const row of rows) {
        const shared = sharedKeywordCount(sourceContentKeywords, contentKeywords(row.content_md));
        if (shared < MIN_SHARED_CONTENT_KEYWORDS) continue;
        const norm = 1 / (1 + Math.max(0, row.rank));
        bump(
          row.luhmann_id,
          0.45 + Math.min(shared * 0.08, 0.45) + norm * 0.08,
          `content overlap ×${shared}`,
        );
      }
    }
  } catch {
    // FTS query 失败（保留字符等）静默忽略
  }

  return [...scores.entries()]
    .filter(([, v]) => v.score >= MIN_POTENTIAL_SCORE)
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

/** 移除所有 [[wikilink]] 包裹的内容，剩下的才是"裸"提及 */
export function stripWikilinks(s: string): string {
  return s.replace(/\[\[[^\]]*\]\]/g, '');
}

/** Remove markup that should not count as semantic prose for potential links. */
export function stripPotentialNoise(s: string): string {
  return stripWikilinks(s)
    // Image alt text and attachment paths are often timestamps / generated filenames.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    // Regular markdown links: keep neither label nor URL for potential matching.
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\battachments\/\S+/gi, ' ')
    .replace(/\b\S+\.(?:png|jpe?g|gif|webp|svg|pdf|zip|md|txt)\b/gi, ' ');
}

/**
 * 把一个标题切成几个可独立引用的关键词。
 *   "主动学习与查询策略" → ["主动学习与查询策略", "主动学习", "查询策略"]
 *   "Active Learning vs Random Sampling" → ["Active Learning vs Random Sampling", "Active Learning", "Random Sampling"]
 *   "RBF" → ["RBF"]
 *
 * 这是为了让 potential 检测能容错"完整标题"vs"概念核心"的差异——
 * 实际写卡时很少会在正文里把另一张卡的完整标题原样抄一遍。
 */
export function titleKeywords(title: string): string[] {
  if (!title) return [];
  // 用  当替身，避免分隔时把多词短语（如 "Active Learning"）按空格切散
  const SEP = '';
  const cleaned = title
    .replace(/[（）()【】\[\]《》]/g, SEP)
    // 英文连接词整词替换为分隔符
    .replace(/\b(?:vs|and|or|with)\b/gi, SEP);
  const parts = cleaned
    // 分隔符：替身 + CJK 标点 + 英文标点 + CJK 单字连接词（不切空白）
    .split(new RegExp(`[${SEP}、，。：；！？,;:!?\\/\\\\|·→\\-—与和及或跟同]+`))
    .map((p) => p.trim())
    .filter(isUsefulPotentialKeyword);
  return [...new Set([title, ...parts])].filter(isUsefulPotentialKeyword);
}

function isUsefulPotentialKeyword(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  if (/^\d+$/.test(t)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  if (/^(daily|journal|note|card|image|attachment)$/i.test(t)) return false;
  return true;
}

export function contentKeywords(markdown: string, limit = 80): string[] {
  const text = stripPotentialNoise(markdown)
    .toLowerCase()
    .replace(/[`*_>#~]/g, ' ');
  const out = new Map<string, number>();
  const add = (token: string) => {
    const t = token.trim();
    if (!isUsefulPotentialKeyword(t)) return;
    if (/^(this|that|with|from|have|will|into|about|there|their|card|note|index|workspace)$/i.test(t)) return;
    out.set(t, (out.get(t) ?? 0) + 1);
  };

  for (const m of text.matchAll(/[a-z][a-z0-9-]{3,}/gi)) add(m[0]);

  for (const m of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu)) {
    const run = m[0];
    if (run.length <= 8) {
      add(run);
    } else {
      for (let i = 0; i <= run.length - 3; i++) add(run.slice(i, i + 3));
    }
  }

  return [...out.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

function sharedKeywordCount(a: string[], b: string[]): number {
  const bSet = new Set(b);
  let n = 0;
  for (const token of new Set(a)) {
    if (bSet.has(token)) n++;
  }
  return n;
}

/**
 * 统计 phrase 在 body 中作为"裸"词的出现次数。
 *   - phrase 必须 >= 2 字符（避免单字符 ID 引爆假阳性）
 *   - 纯 ASCII：在边界用 \b（仅当那一端是 word 字符时；像 "C++" 末尾的 + 不强制 \b）
 *   - 含 CJK：直接全字符串匹配（CJK 的"词边界"语义模糊，宁可宽松也不要漏）
 *   - 调用前请把 body 用 stripWikilinks 处理
 */
export function countUnlinkedHits(body: string, phrase: string): number {
  if (!phrase || phrase.length < 2) return 0;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isAscii = /^[\x00-\x7F]+$/.test(phrase);
  try {
    let re: RegExp;
    if (isAscii) {
      const prefix = /^\w/.test(phrase) ? '\\b' : '';
      const suffix = /\w$/.test(phrase) ? '\\b' : '';
      re = new RegExp(`${prefix}${escaped}${suffix}`, 'gi');
    } else {
      re = new RegExp(escaped, 'g');
    }
    return (body.match(re) || []).length;
  } catch {
    return 0;
  }
}

function sanitizeFtsQuery(s: string): string {
  // 去掉 FTS5 保留字符，只保留中英文/数字
  const tokens = s
    .replace(/["()*:^]/g, ' ')
    .split(/\s+/)
    .filter(isUsefulPotentialKeyword)
    .slice(0, 16);
  return tokens.map((t) => `"${t}"`).join(' OR ');
}
