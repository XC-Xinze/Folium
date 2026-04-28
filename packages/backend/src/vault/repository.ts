import type Database from 'better-sqlite3';
import type { Card } from '../types.js';
import { hooks } from '../hooks.js';
import { getDynamicMembers } from '../services/dynamicMembers.js';

export class CardRepository {
  constructor(private db: Database.Database) {}

  upsertMany(cards: Card[]): void {
    const tx = this.db.transaction((batch: Card[]) => {
      for (const card of batch) this.upsertOne(card);
      for (const card of batch) this.refreshLinks(card);
    });
    tx(cards);
  }

  upsertOne(card: Card): void {
    hooks.emit('card:beforeSave', card);

    this.db
      .prepare(
        `INSERT INTO cards (luhmann_id, title, status, parent_id, sort_key, depth, content_md, file_path, mtime, created_at, updated_at)
         VALUES (@luhmannId, @title, @status, @parentId, @sortKey, @depth, @contentMd, @filePath, @mtime, @createdAt, @updatedAt)
         ON CONFLICT(luhmann_id) DO UPDATE SET
           title = excluded.title,
           status = excluded.status,
           parent_id = excluded.parent_id,
           sort_key = excluded.sort_key,
           depth = excluded.depth,
           content_md = excluded.content_md,
           file_path = excluded.file_path,
           mtime = excluded.mtime,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(card);

    // tags
    this.db.prepare(`DELETE FROM card_tags WHERE luhmann_id = ?`).run(card.luhmannId);
    const insTag = this.db.prepare(`INSERT OR IGNORE INTO tags(name) VALUES (?)`);
    const linkTag = this.db.prepare(`INSERT OR IGNORE INTO card_tags(luhmann_id, tag) VALUES (?, ?)`);
    for (const t of card.tags) {
      insTag.run(t);
      linkTag.run(card.luhmannId, t);
    }

    this.refreshLinks(card);

    hooks.emit('card:afterSave', card);
  }

  refreshLinks(card: Card): void {
    this.db.prepare(`DELETE FROM cross_links WHERE source_id = ?`).run(card.luhmannId);
    const insLink = this.db.prepare(`INSERT OR IGNORE INTO cross_links(source_id, target_id) VALUES (?, ?)`);
    for (const target of card.crossLinks) {
      const targetId = this.resolveLinkTarget(target);
      if (targetId && targetId !== card.luhmannId) insLink.run(card.luhmannId, targetId);
    }
  }

  resolveLinkTarget(target: string): string | null {
    const raw = target.trim();
    if (!raw) return null;

    const exact = this.db.prepare(`SELECT luhmann_id FROM cards WHERE luhmann_id = ?`).get(raw) as
      | { luhmann_id: string }
      | undefined;
    if (exact) return exact.luhmann_id;

    const byTitle = this.db
      .prepare(`SELECT luhmann_id FROM cards WHERE lower(title) = lower(?) ORDER BY sort_key LIMIT 1`)
      .get(raw) as { luhmann_id: string } | undefined;
    if (byTitle) return byTitle.luhmann_id;

    return raw;
  }

  deleteByPath(filePath: string): string | null {
    const row = this.db.prepare(`SELECT luhmann_id FROM cards WHERE file_path = ?`).get(filePath) as
      | { luhmann_id: string }
      | undefined;
    if (!row) return null;
    hooks.emit('card:beforeDelete', row.luhmann_id);
    this.db.prepare(`DELETE FROM cards WHERE luhmann_id = ?`).run(row.luhmann_id);
    return row.luhmann_id;
  }

  list(): Card[] {
    const rows = this.db.prepare(`SELECT * FROM cards ORDER BY sort_key`).all() as RawCardRow[];
    // Derive status:
    // - 顶层 Folgezettel 卡（无 parent）天然是一个盒子 / INDEX
    // - 任何被其他卡 parent_id 指向的卡也是 INDEX
    const indexIds = new Set(
      (
        this.db
          .prepare(`SELECT DISTINCT parent_id FROM cards WHERE parent_id IS NOT NULL`)
          .all() as { parent_id: string }[]
      ).map((r) => r.parent_id),
    );
    return rows.map((r) => this.hydrate(r, r.parent_id === null || indexIds.has(r.luhmann_id)));
  }

  getById(luhmannId: string): Card | null {
    const row = this.db.prepare(`SELECT * FROM cards WHERE luhmann_id = ?`).get(luhmannId) as
      | RawCardRow
      | undefined;
    if (!row) return null;
    const hasChildren =
      this.db.prepare(`SELECT 1 FROM cards WHERE parent_id = ? LIMIT 1`).get(luhmannId) !==
      undefined;
    return this.hydrate(row, row.parent_id === null || hasChildren);
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) as n FROM cards`).get() as { n: number }).n;
  }

  /** vault 切换专用：清空所有衍生数据，让重扫从空开始。FTS 由触发器自动跟随 cards。 */
  truncateAll(): void {
    this.db.exec(`
      DELETE FROM cross_links;
      DELETE FROM card_tags;
      DELETE FROM tags;
      DELETE FROM cards;
    `);
  }

  removeOrphans(existingPaths: Set<string>): number {
    const all = this.db.prepare(`SELECT luhmann_id, file_path FROM cards`).all() as {
      luhmann_id: string;
      file_path: string;
    }[];
    let removed = 0;
    const del = this.db.prepare(`DELETE FROM cards WHERE luhmann_id = ?`);
    for (const row of all) {
      if (!existingPaths.has(row.file_path)) {
        hooks.emit('card:beforeDelete', row.luhmann_id);
        del.run(row.luhmann_id);
        removed += 1;
      }
    }
    return removed;
  }

  private hydrate(row: RawCardRow, isIndex: boolean): Card {
    const tags = (this.db.prepare(`SELECT tag FROM card_tags WHERE luhmann_id = ?`).all(row.luhmann_id) as {
      tag: string;
    }[]).map((t) => t.tag);
    const manualLinks = (this.db
      .prepare(`SELECT target_id FROM cross_links WHERE source_id = ?`)
      .all(row.luhmann_id) as { target_id: string }[]).map((l) => l.target_id);

    // 动态索引：INDEX 卡正文里的 <!-- @members tag:xxx --> 自动展开
    // 仅 INDEX 卡跑（atomic 卡写这个没意义）；对其他类型 0 开销
    let autoMembers: string[] = [];
    if (isIndex && row.content_md.includes('@members')) {
      autoMembers = getDynamicMembers(this.db, row.luhmann_id, row.content_md).filter(
        (id) => !manualLinks.includes(id),
      );
    }

    return {
      luhmannId: row.luhmann_id,
      title: row.title,
      // status 是 derived from structure：顶层卡或有 Folgezettel 子卡就是 INDEX，否则 ATOMIC。
      // frontmatter 的 status 字段被彻底忽略（旧文件里的也没影响）。
      status: isIndex ? 'INDEX' : 'ATOMIC',
      parentId: row.parent_id,
      sortKey: row.sort_key,
      depth: row.depth,
      contentMd: row.content_md,
      tags,
      crossLinks: [...manualLinks, ...autoMembers],
      autoMembers,
      filePath: row.file_path,
      mtime: row.mtime,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

interface RawCardRow {
  luhmann_id: string;
  title: string;
  status: 'ATOMIC' | 'INDEX';
  parent_id: string | null;
  sort_key: string;
  depth: number;
  content_md: string;
  file_path: string;
  mtime: number;
  created_at: string | null;
  updated_at: string | null;
}
