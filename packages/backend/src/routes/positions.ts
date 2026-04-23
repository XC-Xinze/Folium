import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  clearScope,
  deletePosition,
  loadAll,
  loadScope,
  setPosition,
} from '../services/positions.js';

export const positionRoutes: FastifyPluginAsync = async (app) => {
  // 全部数据（调试/导出用）
  app.get('/positions', async () => loadAll());

  // 某 scope 下的所有位置
  app.get<{ Params: { scope: string } }>('/positions/:scope', async (req) => {
    return loadScope(decodeURIComponent(req.params.scope));
  });

  const putSchema = z.object({
    x: z.number(),
    y: z.number(),
  });

  app.put<{ Params: { scope: string; id: string } }>(
    '/positions/:scope/:id',
    async (req, reply) => {
      const parsed = putSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_input' });
      await setPosition(
        decodeURIComponent(req.params.scope),
        decodeURIComponent(req.params.id),
        parsed.data.x,
        parsed.data.y,
      );
      return { ok: true };
    },
  );

  app.delete<{ Params: { scope: string; id: string } }>(
    '/positions/:scope/:id',
    async (req) => {
      await deletePosition(
        decodeURIComponent(req.params.scope),
        decodeURIComponent(req.params.id),
      );
      return { ok: true };
    },
  );

  app.delete<{ Params: { scope: string } }>('/positions/:scope', async (req) => {
    await clearScope(decodeURIComponent(req.params.scope));
    return { ok: true };
  });
};
