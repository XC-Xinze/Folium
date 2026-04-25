import type { FastifyPluginAsync } from 'fastify';
import { CardRepository } from '../vault/repository.js';
import { getDb } from '../db/client.js';
import { emptyTrash, listTrash, purgeTrashEntry, restoreFromTrash, type RestoreStrategy } from '../services/trash.js';

export const trashRoutes: FastifyPluginAsync = async (app) => {
  const repo = new CardRepository(getDb());

  app.get('/trash', async () => {
    return { entries: await listTrash() };
  });

  app.post<{
    Params: { fileName: string };
    Body: { strategy?: RestoreStrategy };
  }>('/trash/:fileName/restore', async (req, reply) => {
    try {
      const strategy = req.body?.strategy ?? 'fail';
      const result = await restoreFromTrash(
        repo,
        decodeURIComponent(req.params.fileName),
        strategy,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: 'restore_failed', message: msg });
    }
  });

  app.delete<{ Params: { fileName: string } }>('/trash/:fileName', async (req) => {
    await purgeTrashEntry(decodeURIComponent(req.params.fileName));
    return { ok: true };
  });

  app.post('/trash/empty', async () => {
    return await emptyTrash();
  });
};
