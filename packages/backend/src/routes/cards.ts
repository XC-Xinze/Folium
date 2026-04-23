import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { CardRepository } from '../vault/repository.js';
import { getLinkedCards, getPotentialLinks, getReferencedFrom, getTagRelated } from '../services/links.js';
import { buildIndexTree } from '../services/indexes.js';
import { demoteCard, promoteCard } from '../services/promote.js';
import { deleteVaultCard } from '../services/deleteCard.js';
import { parseCardFile } from '../vault/parser.js';
import { writeNewCard } from '../vault/writer.js';

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

  app.get('/tags', async () => {
    const rows = db
      .prepare(
        `SELECT t.name, COUNT(ct.luhmann_id) as count
         FROM tags t LEFT JOIN card_tags ct ON ct.tag = t.name
         GROUP BY t.name ORDER BY count DESC`,
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
    status: z.enum(['ATOMIC', 'INDEX']).optional(),
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

  app.get<{ Params: { tag: string } }>('/tags/:tag/cards', async (req, reply) => {
    const tag = decodeURIComponent(req.params.tag).toLowerCase();
    const ids = (db
      .prepare(`SELECT luhmann_id FROM card_tags WHERE tag = ?`)
      .all(tag) as { luhmann_id: string }[]).map((r) => r.luhmann_id);
    const cards = ids.map((id) => repo.getById(id)).filter((c) => c !== null);
    return { tag, cards };
  });
};
