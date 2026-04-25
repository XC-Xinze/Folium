import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  applyEdge,
  createWorkspace,
  deleteEdge,
  deleteWorkspace,
  getWorkspace,
  listDeletedTempNodes,
  listDeletedWorkspaces,
  listWorkspaces,
  listWorkspaceLinksFor,
  purgeDeletedTempNode,
  purgeDeletedWorkspace,
  restoreTempNode,
  restoreWorkspace,
  restoreWorkspaceFromTrash,
  tempToVault,
  trashTempNode,
  unapplyEdge,
  updateWorkspace,
  type TempCardNode,
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

  // 撤销删 workspace —— 从内存软删栈里恢复
  app.post<{ Params: { id: string } }>('/workspaces/:id/restore', async (req, reply) => {
    const ws = await restoreWorkspace(req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_in_trash' });
    return ws;
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

  /* ---- Workspace trash (磁盘持久) ---- */
  app.get('/trash/workspaces', async () => {
    return { entries: await listDeletedWorkspaces() };
  });

  app.post<{ Params: { fileName: string } }>(
    '/trash/workspaces/:fileName/restore',
    async (req, reply) => {
      const ws = await restoreWorkspaceFromTrash(decodeURIComponent(req.params.fileName));
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      return ws;
    },
  );

  app.delete<{ Params: { fileName: string } }>(
    '/trash/workspaces/:fileName',
    async (req) => {
      await purgeDeletedWorkspace(decodeURIComponent(req.params.fileName));
      return { ok: true };
    },
  );

  /* ---- Temp 卡 trash + 删 temp 入口 ---- */
  app.get('/trash/temps', async () => {
    return { entries: await listDeletedTempNodes() };
  });

  app.post<{ Params: { fileName: string } }>(
    '/trash/temps/:fileName/restore',
    async (req, reply) => {
      const result = await restoreTempNode(decodeURIComponent(req.params.fileName));
      if ('error' in result) return reply.code(400).send(result);
      return result;
    },
  );

  app.delete<{ Params: { fileName: string } }>(
    '/trash/temps/:fileName',
    async (req) => {
      await purgeDeletedTempNode(decodeURIComponent(req.params.fileName));
      return { ok: true };
    },
  );

  /**
   * 删 workspace 里某个 node。temp kind 自动入 temp-trash 可还原；
   * card/note 直接从 nodes 里移除。同时把所有触及该 node 的 edge 一并删。
   */
  app.delete<{ Params: { id: string; nodeId: string } }>(
    '/workspaces/:id/nodes/:nodeId',
    async (req, reply) => {
      const ws = await getWorkspace(req.params.id);
      if (!ws) return reply.code(404).send({ error: 'workspace not found' });
      const node = ws.nodes.find((n) => n.id === req.params.nodeId);
      if (!node) return reply.code(404).send({ error: 'node not found' });
      if (node.kind === 'temp') {
        await trashTempNode(ws.id, ws.name, node as TempCardNode);
      }
      const next = await updateWorkspace(ws.id, {
        nodes: ws.nodes.filter((n) => n.id !== node.id),
        edges: ws.edges.filter((e) => e.source !== node.id && e.target !== node.id),
      });
      return next;
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
