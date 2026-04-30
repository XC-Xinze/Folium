import type { FastifyPluginAsync } from 'fastify';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import archiver from 'archiver';
import { getDb } from '../db/client.js';
import { CardRepository } from '../vault/repository.js';
import { config } from '../config.js';
import { assertSafeFileName } from '../security/pathGuards.js';

interface PluginExportFile {
  path: string;
  content: string;
}

interface PluginExportZipBody {
  fileName?: string;
  files?: PluginExportFile[];
  includeAttachments?: boolean;
}

function safeArchivePath(input: string): string {
  if (!input || input.includes('\0')) throw new Error('bad archive path');
  const normalized = posix.normalize(input.replace(/\\/g, '/'));
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('/') ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error('bad archive path');
  }
  return normalized;
}

/**
 * 导出：
 *   GET /export/card/:id        → 单卡 .md（直接下载）
 *   GET /export/subtree/:id     → 以 :id 为根的子树 zip（含 attachments 引用的图片）
 *   GET /export/vault           → 整个 vault zip
 */
export const exportRoutes: FastifyPluginAsync = async (app) => {
  const db = getDb();
  const repo = new CardRepository(db);

  app.get<{ Params: { id: string } }>('/export/card/:id', async (req, reply) => {
    const card = repo.getById(req.params.id);
    if (!card) return reply.code(404).send({ error: 'not_found' });
    const content = await readFile(card.filePath, 'utf8').catch(() => null);
    if (content === null) return reply.code(404).send({ error: 'file_not_found' });
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${basename(card.filePath)}"`);
    return reply.send(content);
  });

  app.get<{ Params: { id: string } }>('/export/subtree/:id', async (req, reply) => {
    const root = repo.getById(req.params.id);
    if (!root) return reply.code(404).send({ error: 'not_found' });

    // 子树：所有 luhmannId 以 root.luhmannId 开头的卡
    const all = repo.list();
    const subtree = all.filter(
      (c) => c.luhmannId === root.luhmannId || c.luhmannId.startsWith(root.luhmannId),
    );
    if (subtree.length === 0) return reply.code(404).send({ error: 'empty_subtree' });

    reply.header('Content-Type', 'application/zip');
    reply.header(
      'Content-Disposition',
      `attachment; filename="vault-subtree-${root.luhmannId}.zip"`,
    );

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => app.log.error({ err }, 'subtree zip error'));
    reply.send(archive);
    for (const c of subtree) {
      archive.file(c.filePath, { name: basename(c.filePath) });
    }
    await archive.finalize();
    return reply;
  });

  app.get('/export/vault', async (_req, reply) => {
    const all = repo.list();
    if (all.length === 0) return reply.code(404).send({ error: 'empty_vault' });

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="vault-${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => app.log.error({ err }, 'vault zip error'));
    reply.send(archive);
    for (const c of all) {
      archive.file(c.filePath, { name: basename(c.filePath) });
    }
    // attachments 目录如果存在 → 整个塞进 zip 的 attachments/ 子目录
    const attDir = join(config.vaultPath, 'attachments');
    const attStat = await stat(attDir).catch(() => null);
    if (attStat?.isDirectory()) {
      archive.directory(attDir, 'attachments');
    }
    await archive.finalize();
    return reply;
  });

  app.post<{ Body: PluginExportZipBody }>('/export/plugin-zip', async (req, reply) => {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length === 0) return reply.code(400).send({ error: 'files_required' });
    if (files.length > 5000) return reply.code(400).send({ error: 'too_many_files' });

    const entries: PluginExportFile[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
        return reply.code(400).send({ error: 'bad_file' });
      }
      let entryName: string;
      try {
        entryName = safeArchivePath(file.path);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      if (seen.has(entryName)) continue;
      seen.add(entryName);
      entries.push({ path: entryName, content: file.content });
    }

    let fileName = 'folium-export.zip';
    try {
      if (req.body?.fileName) fileName = assertSafeFileName(req.body.fileName, '.zip');
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${fileName}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => app.log.error({ err }, 'plugin export zip error'));
    reply.send(archive);

    for (const file of entries) {
      archive.append(file.content, { name: file.path });
    }

    if (req.body?.includeAttachments) {
      const attDir = join(config.vaultPath, 'attachments');
      const attStat = await stat(attDir).catch(() => null);
      if (attStat?.isDirectory()) archive.directory(attDir, 'attachments');
    }

    await archive.finalize();
    return reply;
  });
};
