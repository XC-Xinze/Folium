import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { getDb, closeDb } from './db/client.js';
import { CardRepository } from './vault/repository.js';
import { scanVault } from './vault/scanner.js';
import { watchVault } from './vault/watcher.js';
import { cardRoutes } from './routes/cards.js';
import { attachmentRoutes } from './routes/attachments.js';
import { positionRoutes } from './routes/positions.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { starredRoutes } from './routes/starred.js';
import { trashRoutes } from './routes/trash.js';
import { pluginRoutes } from './routes/plugins.js';
import { exportRoutes } from './routes/export.js';
import { vaultRoutes } from './routes/vaults.js';
import { hooks } from './hooks.js';
import { initVaultRegistry } from './services/vaultRegistry.js';

async function main() {
  const app = Fastify({
    logger: { transport: { target: 'pino-pretty' } },
    bodyLimit: 25 * 1024 * 1024, // 25MB for attachment uploads
  });
  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  // 先 init vault registry：会读 ~/.zettelkasten/config.json 并把 active path 同步到 config，
  // 之后所有 config.vaultPath 才能拿到正确的当前 vault（首次启动会用 VAULT_PATH seed）
  await initVaultRegistry();

  // 静态服务 vault 目录（图片、附件通过 /vault/attachments/xxx.png 访问）
  // 注意：用 serve:false + 手动 sendFile，是因为 @fastify/static 的 root 在 register 时
  // 被 capture，没法跟随 vault switch 变化。这样每次请求都用当前 active vault path。
  await mkdir(join(config.vaultPath, 'attachments'), { recursive: true });
  await app.register(staticPlugin, {
    root: config.vaultPath,
    serve: false,
    decorateReply: true, // 提供 reply.sendFile
  });
  app.get<{ Params: { '*': string } }>('/vault/*', async (req, reply) => {
    const rel = req.params['*'];
    if (!rel || rel.includes('..')) return reply.code(400).send({ error: 'bad path' });
    return reply.sendFile(rel, config.vaultPath);
  });

  // 启动时扫描 vault
  const db = getDb();
  const repo = new CardRepository(db);

  hooks.on('vault:scanned', ({ count, durationMs }) => {
    app.log.info(`vault scan: ${count} cards in ${durationMs}ms`);
  });

  app.log.info(`scanning vault: ${config.vaultPath}`);
  try {
    await scanVault(config.vaultPath, repo);
  } catch (err) {
    app.log.warn({ err }, 'vault scan failed (path may not exist yet)');
  }

  // 监听文件变更。watcher 用 let 绑定，便于 vault switch 时 close 后重建。
  let watcher = watchVault(config.vaultPath, repo);

  await app.register(cardRoutes, { prefix: '/api' });
  await app.register(attachmentRoutes, { prefix: '/api' });
  await app.register(positionRoutes, { prefix: '/api' });
  await app.register(workspaceRoutes, { prefix: '/api' });
  await app.register(starredRoutes, { prefix: '/api' });
  await app.register(trashRoutes, { prefix: '/api' });
  await app.register(pluginRoutes, { prefix: '/api' });
  await app.register(exportRoutes, { prefix: '/api' });
  await app.register(
    (instance, _opts, done) => {
      vaultRoutes(instance, {
        repo,
        getWatcher: () => watcher,
        setWatcher: (w) => {
          watcher = w;
        },
      })
        .then(() => done())
        .catch(done);
    },
    { prefix: '/api' },
  );

  app.get('/api/health', async () => ({
    ok: true,
    cards: repo.count(),
    vaultPath: config.vaultPath,
  }));

  const closeGracefully = async () => {
    app.log.info('shutting down');
    await watcher.close();
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', closeGracefully);
  process.on('SIGTERM', closeGracefully);

  await app.listen({ port: config.port, host: '127.0.0.1' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
