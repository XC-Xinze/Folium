import type { FastifyPluginAsync } from 'fastify';
import { listStarred, star, unstar } from '../services/starred.js';

export const starredRoutes: FastifyPluginAsync = async (app) => {
  app.get('/starred', async () => {
    return { ids: await listStarred() };
  });

  app.put<{ Params: { id: string } }>('/starred/:id', async (req) => {
    await star(decodeURIComponent(req.params.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/starred/:id', async (req) => {
    await unstar(decodeURIComponent(req.params.id));
    return { ok: true };
  });
};
