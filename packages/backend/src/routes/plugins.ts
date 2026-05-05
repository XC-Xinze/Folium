import type { FastifyPluginAsync } from 'fastify';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../config.js';
import { assertSafeFileName } from '../security/pathGuards.js';

const PLUGINS_DIR_REL = '.zettel/plugins';
const OFFICIAL_PLUGINS = [
  {
    name: 'quick-table.js',
    title: 'Quick Table',
    description: 'Insert and format Markdown tables from the command palette or shortcut.',
  },
  {
    name: 'mermaid-renderer.js',
    title: 'Mermaid Renderer',
    description: 'Render fenced mermaid code blocks inside cards and workspace notes.',
  },
  {
    name: 'obsidian-export.js',
    title: 'Obsidian Export',
    description: 'Export the current vault as an Obsidian-compatible Markdown bundle.',
  },
];

async function readOfficialPlugin(name: string): Promise<string | null> {
  const safeName = assertSafeFileName(name, '.js');
  const candidates = [
    join(process.cwd(), 'plugins', safeName),
    resolve(import.meta.dirname, '..', '..', '..', '..', 'plugins', safeName),
    resolve(import.meta.dirname, '..', '..', '..', 'plugins', safeName),
  ];
  for (const candidate of candidates) {
    const src = await readFile(candidate, 'utf8').catch(() => null);
    if (src !== null) return src;
  }
  return null;
}

/**
 * 插件加载：用户把 .js 文件放进 ${vault}/.zettel/plugins/，前端启动时
 * 列出并 dynamic import。沙箱 = 控制 API 表面（不开 fs / 网络任意访问），
 * 不是真隔离——和 Obsidian 一个套路。
 */
export const pluginRoutes: FastifyPluginAsync = async (app) => {
  app.get('/plugins/official', async () => {
    const installed = new Set((await app.inject({ method: 'GET', url: '/api/plugins' })
      .then((res) => JSON.parse(res.payload) as { plugins?: Array<{ name: string }> })
      .catch(() => ({ plugins: [] }))).plugins?.map((p) => p.name) ?? []);
    return {
      plugins: OFFICIAL_PLUGINS.map((p) => ({ ...p, installed: installed.has(p.name) })),
    };
  });

  app.post<{ Params: { name: string } }>('/plugins/official/:name/install', async (req, reply) => {
    const name = req.params.name;
    if (!OFFICIAL_PLUGINS.some((p) => p.name === name)) {
      return reply.code(404).send({ error: 'unknown_official_plugin' });
    }
    const src = await readOfficialPlugin(name);
    if (!src) return reply.code(404).send({ error: 'official_plugin_not_bundled' });

    let dir: string;
    try {
      dir = join(config.vaultPath, PLUGINS_DIR_REL);
    } catch {
      return reply.code(404).send({ error: 'no_active_vault' });
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), src, 'utf8');
    return { ok: true, name };
  });

  app.get('/plugins', async () => {
    let dir: string;
    try {
      dir = join(config.vaultPath, PLUGINS_DIR_REL);
    } catch {
      return { plugins: [] };
    }
    await mkdir(dir, { recursive: true });
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
    let dir: string;
    try {
      dir = join(config.vaultPath, PLUGINS_DIR_REL);
    } catch {
      return reply.code(404).send({ error: 'no_active_vault' });
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
