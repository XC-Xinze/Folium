import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { CardRepository } from '../vault/repository.js';
import { getLinkedCards, getPotentialLinks, getReferencedFrom, getTagRelated } from '../services/links.js';
import { buildIndexTree } from '../services/indexes.js';
import { demoteCard, promoteCard } from '../services/promote.js';
import { planReparent, reparentCard } from '../services/reparent.js';
import { deleteVaultCard } from '../services/deleteCard.js';
import { runSearchReplace } from '../services/searchReplace.js';
import { findDiscoveryClusters } from '../services/discoveries.js';
import { parseCardFile } from '../vault/parser.js';
import { updateCardFile, writeNewCard } from '../vault/writer.js';
import { deleteTag, renameTag } from '../services/renameTag.js';

export const cardRoutes: FastifyPluginAsync = async (app) => {
  const db = getDb();
  const repo = new CardRepository(db);

  app.get('/cards', async () => {
    const cards = repo.list();
    return {
      total: cards.length,
      cards: cards.map((c) => ({
        luhmannId: c.luhmannId,
        title: c.title,
        status: c.status,
        depth: c.depth,
        tags: c.tags,
        sortKey: c.sortKey,
        crossLinks: c.crossLinks,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/cards/:id', async (req, reply) => {
    const card = repo.getById(req.params.id);
    if (!card) return reply.code(404).send({ error: 'not_found' });
    return card;
  });

  app.get<{ Params: { id: string } }>('/cards/:id/linked', async (req, reply) => {
    const card = repo.getById(req.params.id);
    if (!card) return reply.code(404).send({ error: 'not_found' });
    return { linked: getLinkedCards(repo, card) };
  });

  app.get<{ Params: { id: string } }>('/cards/:id/referenced-from', async (req, reply) => {
    const card = repo.getById(req.params.id);
    if (!card) return reply.code(404).send({ error: 'not_found' });
    return { hits: getReferencedFrom(db, repo, card) };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/cards/:id/potential',
    async (req, reply) => {
      const card = repo.getById(req.params.id);
      if (!card) return reply.code(404).send({ error: 'not_found' });
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      return { potential: getPotentialLinks(db, repo, card, limit) };
    },
  );

  // 批量计算每张卡的关联（让 canvas 能为每张骨干卡都展示自己的 orphan）
  const batchSchema = z.object({
    ids: z.array(z.string()),
    potentialLimit: z.number().optional(),
  });
  app.post('/related-batch', async (req, reply) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_input' });
    const { ids, potentialLimit = 5 } = parsed.data;
    const out: Record<string, { tagRelated: ReturnType<typeof getTagRelated>; potential: ReturnType<typeof getPotentialLinks> }> = {};
    for (const id of ids) {
      const card = repo.getById(id);
      if (!card) continue;
      out[id] = {
        tagRelated: getTagRelated(db, repo, card),
        potential: getPotentialLinks(db, repo, card, potentialLimit),
      };
    }
    return out;
  });

  /**
   * 全文搜索：FTS5 + BM25 排名 + snippet 高亮
   *   ?q=关键词 (URL 编码)
   *   ?limit=20 (默认 20)
   * 返回 { hits: [{luhmannId, title, snippet, rank}] }
   */
  app.get<{ Querystring: { q?: string; limit?: string } }>('/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    if (!q || q.length < 2) return { hits: [] };
    // 把 query 拆词，每个词加引号避免 FTS5 语法保留字
    const ftsQuery = q
      .replace(/["()*:^]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 1)
      .map((t) => `"${t}"`)
      .join(' OR ');
    if (!ftsQuery) return { hits: [] };
    try {
      const rows = db
        .prepare(
          `SELECT
            luhmann_id,
            snippet(cards_fts, 2, '⟨', '⟩', '…', 16) AS snippet,
            bm25(cards_fts) AS rank
          FROM cards_fts
          WHERE cards_fts MATCH ?
          ORDER BY rank
          LIMIT ?`,
        )
        .all(ftsQuery, limit) as { luhmann_id: string; snippet: string; rank: number }[];
      const hits = rows
        .map((r) => {
          const c = repo.getById(r.luhmann_id);
          if (!c) return null;
          return {
            luhmannId: c.luhmannId,
            title: c.title,
            snippet: r.snippet,
            rank: Number(r.rank.toFixed(3)),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      return { hits };
    } catch {
      return { hits: [] };
    }
  });

  // 全局搜索替换：dryRun=true 时只返回 preview，不动文件
  const searchReplaceSchema = z.object({
    query: z.string().min(1),
    replacement: z.string(),
    useRegex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    bodyOnly: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  });
  app.post('/search-replace', async (req, reply) => {
    const parsed = searchReplaceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_input', detail: parsed.error.flatten() });
    try {
      const result = await runSearchReplace(repo, parsed.data);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: 'search_replace_failed', message: msg });
    }
  });

  /** Discovery：找还没被 INDEX 收的"看起来是同一类"的卡簇 */
  app.get('/discoveries', async () => {
    return { clusters: findDiscoveryClusters(db, repo) };
  });

  app.get('/tags', async () => {
    // 直接从 card_tags 聚合，避免 tags 表残留孤儿名
    // （rename / delete 会让 card_tags 同步，但 tags 主表可能留死项 → count=0 的幽灵 tag）
    const rows = db
      .prepare(
        `SELECT tag AS name, COUNT(*) as count
         FROM card_tags
         GROUP BY tag ORDER BY count DESC`,
      )
      .all() as { name: string; count: number }[];
    return { tags: rows };
  });

  const newCardSchema = z.object({
    luhmannId: z.string().min(1),
    title: z.string().min(1),
    content: z.string().default(''),
    tags: z.array(z.string()).optional(),
    crossLinks: z.array(z.string()).optional(),
  });

  app.post('/cards', async (req, reply) => {
    const parse = newCardSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'bad_input', detail: parse.error.flatten() });
    try {
      const { filePath, luhmannId } = await writeNewCard(parse.data);
      // 不等 chokidar，立即 upsert，前端马上能拿到
      const card = await parseCardFile(filePath);
      if (card) repo.upsertOne(card);
      return reply.code(201).send({ luhmannId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) return reply.code(409).send({ error: 'conflict', message: msg });
      return reply.code(400).send({ error: 'write_failed', message: msg });
    }
  });

  /**
   * Daily note: GET-or-create today's journal card.
   *   id: daily20260424 形式（canonical 化后的日期）
   *   title: "Daily · YYYY-MM-DD"
   *   tags: ["daily"]
   * 前端拿到 luhmannId 后直接 navigate 过去即可。
   */
  app.post<{ Body: { date?: string } }>('/daily', async (req, reply) => {
    const date = (req.body?.date ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.code(400).send({ error: 'bad_date' });
    }
    const luhmannId = `daily${date.replace(/-/g, '')}`;
    const existing = repo.getById(luhmannId);
    if (existing) return reply.send({ luhmannId, created: false });
    try {
      const { filePath } = await writeNewCard({
        luhmannId,
        title: `Daily · ${date}`,
        content: `# Daily · ${date}\n\n`,
        tags: ['daily'],
      });
      const card = await parseCardFile(filePath);
      if (card) repo.upsertOne(card);
      return reply.code(201).send({ luhmannId, created: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: 'write_failed', message: msg });
    }
  });

  app.get('/indexes', async () => {
    return { tree: buildIndexTree(db, repo) };
  });

  app.post<{ Params: { id: string } }>('/cards/:id/promote', async (req, reply) => {
    try {
      const result = await promoteCard(db, repo, req.params.id);
      return reply.code(200).send(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: 'promote_failed', message: msg });
    }
  });

  /**
   * Reparent: 把一张卡（连同子树）挪到另一个父级下，按 Folgezettel 自动重编号。
   * Body: { sourceId, newParentId: string|null, dryRun?: boolean }
   *   dryRun=true → 只算 rename map 不动文件，给前端预览/确认
   */
  app.post<{ Body: { sourceId: string; newParentId: string | null; dryRun?: boolean } }>(
    '/cards/reparent',
    async (req, reply) => {
      const { sourceId, newParentId, dryRun } = req.body ?? {};
      if (!sourceId || (newParentId !== null && typeof newParentId !== 'string')) {
        return reply.code(400).send({ error: 'sourceId required; newParentId must be string|null' });
      }
      try {
        if (dryRun) {
          const plan = planReparent(repo, sourceId, newParentId);
          return { renames: Object.fromEntries(plan.renames), filesUpdated: 0, dryRun: true };
        }
        const result = await reparentCard(db, repo, sourceId, newParentId);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: 'reparent_failed', message: msg });
      }
    },
  );

  /**
   * 把一条 potential（文本相似/被 mention）关系提升成真正的双链：
   * 在 source 卡 body 末尾追加 [[targetId]]。重复调用幂等。
   */
  app.post<{ Params: { id: string }; Body: { targetId: string } }>(
    '/cards/:id/append-link',
    async (req, reply) => {
      const card = repo.getById(req.params.id);
      if (!card) return reply.code(404).send({ error: 'not_found' });
      const targetId = req.body?.targetId?.trim();
      if (!targetId) return reply.code(400).send({ error: 'targetId required' });
      // 已含 [[targetId]] → 幂等返回
      const linkRe = new RegExp(`\\[\\[${targetId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:\\|[^\\]]+)?\\]\\]`);
      if (linkRe.test(card.contentMd)) {
        return { card, alreadyLinked: true };
      }
      const newBody = card.contentMd.replace(/\s+$/, '') + `\n\n[[${targetId}]]\n`;
      try {
        await updateCardFile(card.filePath, { content: newBody });
        const reparsed = await parseCardFile(card.filePath);
        if (reparsed) repo.upsertOne(reparsed);
        return { card: reparsed ?? card, alreadyLinked: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: 'append_failed', message: msg });
      }
    },
  );

  /**
   * 取消双链：移除 source 卡 body 里指向 targetId 的 [[link]]（含可选 |alias）。
   * 顺手清掉因此可能留下的空行。幂等：找不到也返回 ok。
   */
  app.post<{ Params: { id: string }; Body: { targetId: string } }>(
    '/cards/:id/remove-link',
    async (req, reply) => {
      const card = repo.getById(req.params.id);
      if (!card) return reply.code(404).send({ error: 'not_found' });
      const targetId = req.body?.targetId?.trim();
      if (!targetId) return reply.code(400).send({ error: 'targetId required' });
      const escaped = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 整行只有 [[link]] → 删整行（连同换行），否则只把 [[link]] / [[link|alias]] 移除
      const body = card.contentMd;
      const standaloneRe = new RegExp(
        `^[ \\t]*\\[\\[${escaped}(?:\\|[^\\]]+)?\\]\\][ \\t]*\\r?\\n?`,
        'gm',
      );
      const inlineRe = new RegExp(`\\[\\[${escaped}(?:\\|[^\\]]+)?\\]\\]`, 'g');
      let mut = body.replace(standaloneRe, '');
      mut = mut.replace(inlineRe, '');
      // 多个连续空行折成一个
      mut = mut.replace(/\n{3,}/g, '\n\n');
      const removed = mut !== body;
      if (!removed) return { card, removed: false };
      try {
        await updateCardFile(card.filePath, { content: mut });
        const reparsed = await parseCardFile(card.filePath);
        if (reparsed) repo.upsertOne(reparsed);
        return { card: reparsed ?? card, removed: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: 'remove_failed', message: msg });
      }
    },
  );

  const updateSchema = z.object({
    title: z.string().optional(),
    content: z.string().optional(),
    tags: z.array(z.string()).optional(),
  });

  app.patch<{ Params: { id: string } }>('/cards/:id', async (req, reply) => {
    const card = repo.getById(req.params.id);
    if (!card) return reply.code(404).send({ error: 'not_found' });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_input', detail: parsed.error.flatten() });
    try {
      await updateCardFile(card.filePath, parsed.data);
      // 立即重新解析入库
      const reparsed = await parseCardFile(card.filePath);
      if (reparsed) repo.upsertOne(reparsed);
      return reparsed ?? card;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: 'update_failed', message: msg });
    }
  });

  app.put<{ Params: { tag: string }; Body: { newName: string } }>(
    '/tags/:tag/rename',
    async (req, reply) => {
      try {
        const result = await renameTag(db, repo, req.params.tag, req.body.newName);
        return result;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: 'rename_failed', message: msg });
      }
    },
  );

  app.delete<{ Params: { tag: string } }>('/tags/:tag', async (req, reply) => {
    try {
      const result = await deleteTag(db, repo, decodeURIComponent(req.params.tag));
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: 'delete_failed', message: msg });
    }
  });

  app.delete<{ Params: { id: string } }>('/cards/:id', async (req, reply) => {
    try {
      const result = await deleteVaultCard(db, repo, req.params.id);
      return reply.code(200).send(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: 'delete_failed', message: msg });
    }
  });

  app.post<{ Params: { id: string } }>('/cards/:id/demote', async (req, reply) => {
    try {
      const result = await demoteCard(db, repo, req.params.id);
      return reply.code(200).send(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: 'demote_failed', message: msg });
    }
  });

  app.get<{ Params: { id: string } }>('/cards/:id/tag-related', async (req, reply) => {
    const card = repo.getById(req.params.id);
    if (!card) return reply.code(404).send({ error: 'not_found' });
    return { related: getTagRelated(db, repo, card) };
  });

  /**
   * Tag 建议：根据相似卡（potential + tag-related）的 tag 频率排序，
   * 返回当前卡还没有的 top tag。前端在编辑模式下展示 → 一键加。
   */
  app.get<{ Params: { id: string } }>('/cards/:id/tag-suggestions', async (req, reply) => {
    const card = repo.getById(req.params.id);
    if (!card) return reply.code(404).send({ error: 'not_found' });
    const ownTags = new Set(card.tags);
    const tagScore = new Map<string, number>();
    const bump = (t: string, w: number) => {
      if (ownTags.has(t)) return;
      tagScore.set(t, (tagScore.get(t) ?? 0) + w);
    };
    // 信号 1: tag-related（共享 tag 的卡的其他 tag —— 同主题不同子标签）
    for (const tr of getTagRelated(db, repo, card)) {
      const c = repo.getById(tr.luhmannId);
      if (!c) continue;
      for (const t of c.tags) bump(t, tr.jaccard);
    }
    // 信号 2: potential（内容相似的卡的 tag）
    for (const p of getPotentialLinks(db, repo, card, 20)) {
      const c = repo.getById(p.luhmannId);
      if (!c) continue;
      for (const t of c.tags) bump(t, p.score * 0.5);
    }
    const suggestions = [...tagScore.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, score]) => ({ name, score: Number(score.toFixed(3)) }));
    return { suggestions };
  });

  app.get<{ Params: { tag: string } }>('/tags/:tag/cards', async (req, reply) => {
    const tag = decodeURIComponent(req.params.tag).toLowerCase();
    const ids = (db
      .prepare(`SELECT luhmann_id FROM card_tags WHERE tag = ?`)
      .all(tag) as { luhmann_id: string }[]).map((r) => r.luhmann_id);
    const cards = ids.map((id) => repo.getById(id)).filter((c) => c !== null);
    return { tag, cards };
  });
};
