import type { FastifyPluginAsync } from 'fastify';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { CardRepository } from '../vault/repository.js';
import { createResource, deleteResource, getResource, inferKindFromPath, listResourceReferences, listResources, updateResource } from '../services/resources.js';

const RESOURCE_ATTACHMENTS_DIR = 'attachments/resources';
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);

function sanitizeName(name: string): string {
  return basename(name)
    .replace(/[\x00-\x1f\\/]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

function timestampPrefix(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseTags(input: unknown): string[] {
  if (typeof input !== 'string') return [];
  return input
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export const resourceRoutes: FastifyPluginAsync = async (app) => {
  const repo = new CardRepository(getDb());

  app.get<{ Querystring: { parentBoxId?: string } }>('/resources', async (req) => {
    const parentBoxId = req.query.parentBoxId === undefined ? undefined : (req.query.parentBoxId || null);
    const resources = await listResources(parentBoxId);
    return { resources };
  });

  app.get('/resources/references', async () => {
    const references = await listResourceReferences(repo);
    return { references };
  });

  app.get<{ Params: { id: string } }>('/resources/:id', async (req, reply) => {
    const resource = await getResource(req.params.id);
    if (!resource) return reply.code(404).send({ error: 'not_found' });
    return resource;
  });

  app.patch<{
    Params: { id: string };
    Body: { title?: string; tags?: string[]; parentBoxId?: string | null; note?: string };
  }>('/resources/:id', async (req, reply) => {
    const resource = await updateResource(req.params.id, req.body ?? {});
    if (!resource) return reply.code(404).send({ error: 'not_found' });
    return resource;
  });

  app.delete<{ Params: { id: string } }>('/resources/:id', async (req, reply) => {
    const result = await deleteResource(req.params.id);
    if (!result) return reply.code(404).send({ error: 'not_found' });
    return result;
  });

  app.post<{ Querystring: { parentBoxId?: string } }>('/resources', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'no_file' });

    const ext = extname(data.filename).toLowerCase();
    const absDir = join(config.vaultPath, RESOURCE_ATTACHMENTS_DIR);
    await mkdir(absDir, { recursive: true });
    const safeBase = sanitizeName(data.filename.replace(ext, '')) || 'resource';
    const finalName = `${timestampPrefix()}-${safeBase}${ext}`;
    const relPath = `${RESOURCE_ATTACHMENTS_DIR}/${finalName}`;
    const buf = await data.toBuffer();
    await writeFile(join(absDir, finalName), buf);

    const fields = data.fields as Record<string, { value?: unknown } | undefined>;
    const title = typeof fields.title?.value === 'string' && fields.title.value.trim()
      ? fields.title.value.trim()
      : safeBase;
    const tags = parseTags(fields.tags?.value);
    const parentBoxId = req.query.parentBoxId?.trim() || null;
    const note = typeof fields.note?.value === 'string' ? fields.note.value : '';
    const resource = await createResource({ kind: inferKindFromPath(relPath), title, path: relPath, tags, parentBoxId, note });
    return reply.code(201).send({ resource });
  });

  app.post<{ Querystring: { parentBoxId?: string } }>('/resources/image', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'no_file' });

    const ext = extname(data.filename).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) {
      return reply.code(400).send({ error: 'unsupported_image_type' });
    }

    const absDir = join(config.vaultPath, RESOURCE_ATTACHMENTS_DIR);
    await mkdir(absDir, { recursive: true });
    const safeBase = sanitizeName(data.filename.replace(ext, '')) || 'image';
    const finalName = `${timestampPrefix()}-${safeBase}${ext}`;
    const relPath = `${RESOURCE_ATTACHMENTS_DIR}/${finalName}`;
    const buf = await data.toBuffer();
    await writeFile(join(absDir, finalName), buf);

    const fields = data.fields as Record<string, { value?: unknown } | undefined>;
    const title = typeof fields.title?.value === 'string' && fields.title.value.trim()
      ? fields.title.value.trim()
      : safeBase;
    const tags = parseTags(fields.tags?.value);
    const parentBoxId = req.query.parentBoxId?.trim() || null;
    const note = typeof fields.note?.value === 'string' ? fields.note.value : '';
    const resource = await createResource({ kind: 'image', title, path: relPath, tags, parentBoxId, note });
    return reply.code(201).send({ resource });
  });
};
