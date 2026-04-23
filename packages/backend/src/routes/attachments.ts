import type { FastifyPluginAsync } from 'fastify';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { config } from '../config.js';

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

export const attachmentRoutes: FastifyPluginAsync = async (app) => {
  const dir = join(config.vaultPath, ATTACHMENTS_DIR);
  await mkdir(dir, { recursive: true });

  app.post('/attachments', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'no_file' });

    const ext = extname(data.filename) || '';
    const safe = sanitizeName(data.filename.replace(ext, ''));
    const finalName = `${timestampPrefix()}-${safe}${ext}`;
    const finalPath = join(dir, finalName);

    const buf = await data.toBuffer();
    await writeFile(finalPath, buf);

    // 返回相对 vault 的路径，前端用 ![](attachments/xxx.png) 引用
    return reply.code(201).send({
      filename: finalName,
      relativePath: `${ATTACHMENTS_DIR}/${finalName}`,
      url: `/vault/${ATTACHMENTS_DIR}/${finalName}`,
      mimetype: data.mimetype,
      size: buf.length,
    });
  });
};
