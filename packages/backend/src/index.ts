import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config, getActiveVaultPath } from './config.js';
import { getDb, closeDb } from './db/client.js';
import { CardRepository } from './vault/repository.js';
import { scanVault } from './vault/scanner.js';
import { watchVault } from './vault/watcher.js';
import { cardRoutes } from './routes/cards.js';
import { attachmentRoutes } from './routes/attachments.js';
import { resourceRoutes } from './routes/resources.js';
import { positionRoutes } from './routes/positions.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { starredRoutes } from './routes/starred.js';
import { trashRoutes } from './routes/trash.js';
import { pluginRoutes } from './routes/plugins.js';
import { exportRoutes } from './routes/export.js';
import { vaultRoutes } from './routes/vaults.js';
import { hooks } from './hooks.js';
import { getActiveVault, initVaultRegistry } from './services/vaultRegistry.js';
import { startBackupScheduler, stopBackupScheduler } from './services/backup.js';
import { resolveInside } from './security/pathGuards.js';

function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (config.corsOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function main() {
  const app = Fastify({
    logger: { transport: { target: 'pino-pretty' } },
    bodyLimit: 25 * 1024 * 1024, // 25MB for attachment uploads
  });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (isAllowedCorsOrigin(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error(`CORS origin not allowed: ${origin}`), false);
    },
  });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  if (config.apiToken) {
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/') || req.method === 'OPTIONS') return;
      if (req.headers['x-folium-token'] === config.apiToken) return;
      return reply.code(401).send({ error: 'unauthorized' });
    });
  }

  // 先 init vault registry：会读 ~/.zettelkasten/config.json 并把 active path 同步到 config，
  // 之后所有 config.vaultPath 才能拿到正确的当前 vault（首次启动会用 VAULT_PATH seed）
  await initVaultRegistry();

  // 静态服务 vault 目录（图片、附件通过 /vault/attachments/xxx.png 访问）
  // 注意：用 serve:false + 手动 sendFile，是因为 @fastify/static 的 root 在 register 时
  // 被 capture，没法跟随 vault switch 变化。这样每次请求都用当前 active vault path。
  const initialVault = getActiveVault();
  const initialVaultPath = initialVault?.path ?? null;

  if (initialVaultPath) {
    await mkdir(join(initialVaultPath, 'attachments'), { recursive: true });
  }
  await app.register(staticPlugin, {
    root: initialVaultPath ?? process.cwd(),
    serve: false,
    decorateReply: true, // 提供 reply.sendFile
  });
  app.get<{ Params: { '*': string } }>('/vault/*', async (req, reply) => {
    const rel = req.params['*'];
    const activePath = getActiveVaultPath();
    if (!activePath) return reply.code(404).send({ error: 'no active vault' });
    try {
      resolveInside(activePath, rel);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return reply.sendFile(rel, activePath);
  });

  // 启动时扫描 vault
  const db = getDb();
  const repo = new CardRepository(db);
  if (!initialVaultPath) {
    repo.truncateAll();
  }

  hooks.on('vault:scanned', ({ count, durationMs }) => {
    app.log.info(`vault scan: ${count} cards in ${durationMs}ms`);
  });

  if (initialVaultPath) {
    app.log.info(`scanning vault: ${initialVaultPath}`);
    try {
      await scanVault(initialVaultPath, repo);
    } catch (err) {
      app.log.warn({ err }, 'vault scan failed (path may not exist yet)');
    }
  }

  // 监听文件变更。watcher 用 let 绑定，便于 vault switch 时 close 后重建。
  let watcher = initialVaultPath ? watchVault(initialVaultPath, repo) : null;

  // 起自动备份调度（settings.backupEnabled 默认 true）
  if (initialVaultPath) startBackupScheduler();

  await app.register(cardRoutes, { prefix: '/api' });
  await app.register(attachmentRoutes, { prefix: '/api' });
  await app.register(resourceRoutes, { prefix: '/api' });
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
    vaultPath: getActiveVaultPath(),
  }));

  const closeGracefully = async () => {
    app.log.info('shutting down');
    stopBackupScheduler();
    await watcher?.close();
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', closeGracefully);
  process.on('SIGTERM', closeGracefully);

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
