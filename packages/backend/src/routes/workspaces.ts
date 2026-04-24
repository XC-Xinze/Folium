import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  applyEdge,
  createWorkspace,
  deleteEdge,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  listWorkspaceLinksFor,
  tempToVault,
  unapplyEdge,
  updateWorkspace,
  type WorkspaceEdge,
  type WorkspaceNode,
} from '../services/workspaces.js';
import { CardRepository } from '../vault/repository.js';
import { getDb } from '../db/client.js';

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  const repo = new CardRepository(getDb());

  app.get('/workspaces', async () => {
    const list = await listWorkspaces();
    return { workspaces: list };
  });

  app.post('/workspaces', async (req, reply) => {
    const body = req.body as { name?: string } | undefined;
    const ws = await createWorkspace(body?.name ?? '新工作区');
    return reply.code(201).send(ws);
  });

  app.get<{ Params: { id: string } }>('/workspaces/:id', async (req, reply) => {
    const ws = await getWorkspace(req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    return ws;
  });

  const updateSchema = z.object({
    name: z.string().optional(),
    nodes: z.array(z.unknown()).optional(),
    edges: z.array(z.unknown()).optional(),
  });
  app.put<{ Params: { id: string } }>('/workspaces/:id', async (req, reply) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_input' });
    try {
      const ws = await updateWorkspace(req.params.id, {
        name: parsed.data.name,
        nodes: parsed.data.nodes as WorkspaceNode[] | undefined,
        edges: parsed.data.edges as WorkspaceEdge[] | undefined,
      });
      return ws;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: 'update_failed', message: msg });
    }
  });

  app.delete<{ Params: { id: string } }>('/workspaces/:id', async (req) => {
    await deleteWorkspace(req.params.id);
    return { ok: true };
  });

  // Apply edge to vault
  app.post<{ Params: { id: string }; Body: { edgeId: string } }>(
    '/workspaces/:id/apply-edge',
    async (req, reply) => {
      const result = await applyEdge(repo, req.params.id, req.body.edgeId);
      if ('error' in result) return reply.code(400).send(result);
      return result;
    },
  );

  app.post<{ Params: { id: string }; Body: { edgeId: string } }>(
    '/workspaces/:id/unapply-edge',
    async (req, reply) => {
      const result = await unapplyEdge(repo, req.params.id, req.body.edgeId);
      if ('error' in result) return reply.code(400).send(result);
      return result;
    },
  );

  // Delete an edge entirely (unapplies first if applied)
  app.delete<{ Params: { id: string; edgeId: string } }>(
    '/workspaces/:id/edges/:edgeId',
    async (req, reply) => {
      const result = await deleteEdge(repo, req.params.id, req.params.edgeId);
      if ('error' in result) return reply.code(400).send(result);
      return result;
    },
  );

  // Temp card → real vault card
  const tempSchema = z.object({
    nodeId: z.string(),
    luhmannId: z.string().min(1),
  });
  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/temp-to-vault',
    async (req, reply) => {
      const parsed = tempSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_input' });
      const result = await tempToVault(repo, req.params.id, parsed.data.nodeId, parsed.data.luhmannId);
      if ('error' in result) return reply.code(400).send(result);
      return result;
    },
  );

  // Batch: workspace edges touching the given vault cards.
  // Used by the vault canvas to render workspace-derived links/temps as potential-style overlays.
  const wsLinksSchema = z.object({ cardIds: z.array(z.string()) });
  app.post('/workspace-links/batch', async (req, reply) => {
    const parsed = wsLinksSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_input' });
    const links = await listWorkspaceLinksFor(parsed.data.cardIds);
    return { links };
  });
};
