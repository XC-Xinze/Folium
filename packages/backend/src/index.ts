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
import { hooks } from './hooks.js';

async function main() {
  const app = Fastify({
    logger: { transport: { target: 'pino-pretty' } },
    bodyLimit: 25 * 1024 * 1024, // 25MB for attachment uploads
  });
  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  // 静态服务 vault 目录（图片、附件等通过 /vault/attachments/xxx.png 访问）
  await mkdir(join(config.vaultPath, 'attachments'), { recursive: true });
  await app.register(staticPlugin, {
    root: config.vaultPath,
    prefix: '/vault/',
    decorateReply: false,
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

  // 监听文件变更
  const watcher = watchVault(config.vaultPath, repo);

  await app.register(cardRoutes, { prefix: '/api' });
  await app.register(attachmentRoutes, { prefix: '/api' });
  await app.register(positionRoutes, { prefix: '/api' });
  await app.register(workspaceRoutes, { prefix: '/api' });
  await app.register(starredRoutes, { prefix: '/api' });

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
