import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  clearPositions,
  deletePosition,
  loadPositions,
  setPosition,
} from '../services/positions.js';

export const positionRoutes: FastifyPluginAsync = async (app) => {
  app.get('/positions', async () => loadPositions());

  const putSchema = z.object({
    x: z.number(),
    y: z.number(),
  });

  app.put<{ Params: { id: string } }>('/positions/:id', async (req, reply) => {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_input' });
    await setPosition(req.params.id, parsed.data.x, parsed.data.y);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/positions/:id', async (req) => {
    await deletePosition(req.params.id);
    return { ok: true };
  });

  app.delete('/positions', async () => {
    await clearPositions();
    return { ok: true };
  });
};
