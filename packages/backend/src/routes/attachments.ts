import type { FastifyPluginAsync } from 'fastify';
import { mkdir, writeFile, access, readdir, stat, unlink } from 'node:fs/promises';
import { join, extname, basename, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { config } from '../config.js';
import { getVaultSettings } from '../services/vaultSettings.js';
import { getDb } from '../db/client.js';
import { CardRepository } from '../vault/repository.js';

const ATTACHMENTS_DIR = 'attachments';

function sanitizeName(name: string): string {
  // 去掉路径分隔符与控制字符；保留中英文/数字/常见符号
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

/** 根据 vault 设置 + 可选的 boxId 算附件目录（vault 相对路径返回） */
async function resolveAttachmentDir(boxId: string | null): Promise<{
  absDir: string;
  relPath: string;
}> {
  const settings = await getVaultSettings();
  // per-box 模式且有 boxId → 子目录；否则全局
  if (settings.attachmentPolicy === 'per-box' && boxId && /^[\da-z]+$/i.test(boxId)) {
    const rel = `${ATTACHMENTS_DIR}/${boxId}`;
    return { absDir: join(config.vaultPath, rel), relPath: rel };
  }
  return {
    absDir: join(config.vaultPath, ATTACHMENTS_DIR),
    relPath: ATTACHMENTS_DIR,
  };
}

function assertVaultRelativeAttachmentPath(relativePath: string): string {
  const rel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel.startsWith(`${ATTACHMENTS_DIR}/`) || rel.includes('\0')) {
    throw new Error('attachment path required');
  }
  const vault = resolve(config.vaultPath);
  const target = resolve(vault, rel);
  if (target === vault || !target.startsWith(vault + sep)) {
    throw new Error('path escapes vault');
  }
  return target;
}

async function walkAttachments(dir: string, base = ATTACHMENTS_DIR): Promise<Array<{ relativePath: string; size: number; mtime: number }>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: Array<{ relativePath: string; size: number; mtime: number }> = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = `${base}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...await walkAttachments(abs, rel));
      continue;
    }
    if (!entry.isFile()) continue;
    const s = await stat(abs).catch(() => null);
    if (!s) continue;
    out.push({ relativePath: rel, size: s.size, mtime: s.mtimeMs });
  }
  return out;
}

function findAttachmentReferences(relativePath: string): Array<{ luhmannId: string; title: string }> {
  const repo = new CardRepository(getDb());
  const encoded = encodeURI(relativePath);
  return repo
    .list()
    .filter((card) => card.contentMd.includes(relativePath) || card.contentMd.includes(encoded))
    .map((card) => ({ luhmannId: card.luhmannId, title: card.title }));
}

export const attachmentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/attachments', async () => {
    const files = await walkAttachments(join(config.vaultPath, ATTACHMENTS_DIR));
    return {
      attachments: files
        .map((file) => ({
          ...file,
          referencedBy: findAttachmentReferences(file.relativePath),
        }))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    };
  });

  // 注意：不在 register 时确定 dir —— vault 切换 / 设置改变时都会变。
  // 每次 upload 现算。
  app.post<{ Querystring: { boxId?: string } }>('/attachments', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'no_file' });

    const boxId = req.query?.boxId ?? null;
    const { absDir, relPath } = await resolveAttachmentDir(boxId);
    await mkdir(absDir, { recursive: true });

    const ext = extname(data.filename) || '';
    const safe = sanitizeName(data.filename.replace(ext, ''));
    const finalName = `${timestampPrefix()}-${safe}${ext}`;
    const finalPath = join(absDir, finalName);

    const buf = await data.toBuffer();
    await writeFile(finalPath, buf);

    // 返回相对 vault 的路径，前端用 ![[...]] 引用
    return reply.code(201).send({
      filename: finalName,
      relativePath: `${relPath}/${finalName}`,
      url: `/vault/${relPath}/${finalName}`,
      mimetype: data.mimetype,
      size: buf.length,
    });
  });

  /**
   * 用系统默认应用打开 vault 内的某个附件（PDF / 图片 / 任何文件）。
   * Body: { relativePath: 'attachments/foo.pdf' }
   * 安全：解析后必须仍在 vault 目录里，防 path traversal。
   */
  app.post<{ Body: { relativePath: string } }>(
    '/attachments/open',
    async (req, reply) => {
      const rel = req.body?.relativePath;
      if (!rel || typeof rel !== 'string') {
        return reply.code(400).send({ error: 'relativePath required' });
      }
      const vault = resolve(config.vaultPath);
      const target = resolve(vault, rel);
      // 必须在 vault 内
      if (target !== vault && !target.startsWith(vault + sep)) {
        return reply.code(400).send({ error: 'path escapes vault' });
      }
      try {
        await access(target);
      } catch {
        return reply.code(404).send({ error: 'file not found' });
      }
      const cmd =
        platform() === 'darwin' ? 'open' :
        platform() === 'win32' ? 'cmd' :
        'xdg-open';
      const args = platform() === 'win32' ? ['/c', 'start', '', target] : [target];
      try {
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
      return { ok: true };
    },
  );

  app.delete<{ Querystring: { path?: string; force?: string } }>('/attachments', async (req, reply) => {
    const rel = req.query.path;
    if (!rel || typeof rel !== 'string') {
      return reply.code(400).send({ error: 'path required' });
    }
    let target: string;
    try {
      target = assertVaultRelativeAttachmentPath(rel);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const refs = findAttachmentReferences(rel);
    const force = req.query.force === '1' || req.query.force === 'true';
    if (refs.length > 0 && !force) {
      return reply.code(409).send({ error: 'attachment is referenced', referencedBy: refs });
    }
    try {
      await unlink(target);
      return { ok: true, deleted: rel, referencedBy: refs };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });
};
