import type { FastifyPluginAsync } from 'fastify';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

const PLUGINS_DIR_REL = '.zettel/plugins';

/**
 * 插件加载：用户把 .js 文件放进 ${vault}/.zettel/plugins/，前端启动时
 * 列出并 dynamic import。沙箱 = 控制 API 表面（不开 fs / 网络任意访问），
 * 不是真隔离——和 Obsidian 一个套路。
 */
export const pluginRoutes: FastifyPluginAsync = async (app) => {
  const dir = join(config.vaultPath, PLUGINS_DIR_REL);
  await mkdir(dir, { recursive: true });

  app.get('/plugins', async () => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const plugins: { name: string; size: number; mtime: number }[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.js')) continue;
      const full = join(dir, e.name);
      const s = await stat(full).catch(() => null);
      if (!s) continue;
      plugins.push({ name: e.name, size: s.size, mtime: s.mtimeMs });
    }
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    return { plugins };
  });

  // 单插件源码：前端拿到后用 Blob + dynamic import 加载
  app.get<{ Params: { name: string } }>('/plugins/:name', async (req, reply) => {
    const name = req.params.name;
    // 防路径穿越：只允许文件名（不含 / .. 等）
    if (!/^[\w.-]+\.js$/.test(name)) {
      return reply.code(400).send({ error: 'bad_name' });
    }
    const full = join(dir, name);
    try {
      const src = await readFile(full, 'utf8');
      reply.header('Content-Type', 'text/javascript; charset=utf-8');
      return reply.send(src);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });
};
