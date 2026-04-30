/**
 * Vault registry HTTP routes：list / register / unregister / switch / active。
 *
 * Switch 是核心：闭包要拿到 main() 里的 watcher + repo + scanVault 才能完成
 * "停 watcher → truncate db → setActiveVaultId → scanVault → 起新 watcher" 流程。
 * 所以这个 plugin 接受一个 ctx 参数，由 main() 注入这些资源。
 */
import type { FastifyInstance } from 'fastify';
import type { CardRepository } from '../vault/repository.js';
import type { FSWatcher } from 'chokidar';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  listVaults,
  getActiveVault,
  registerVault,
  unregisterVault,
  setActiveVaultId,
} from '../services/vaultRegistry.js';
import { resetWorkspacesCache } from '../services/workspaces.js';
import { resetPositionsCache } from '../services/positions.js';
import { resetStarredCache } from '../services/starred.js';
import { resetVaultSettingsCache, getVaultSettings, patchVaultSettings, type VaultSettings } from '../services/vaultSettings.js';
import {
  createBackup,
  listBackups,
  purgeBackup,
  restoreBackup,
  startBackupScheduler,
} from '../services/backup.js';
import { scanVault } from '../vault/scanner.js';
import { watchVault } from '../vault/watcher.js';
import { config } from '../config.js';

export interface VaultRoutesCtx {
  repo: CardRepository;
  /** main() 持有 watcher 的引用槽。switch 会 close 旧的 + 写入新的。 */
  getWatcher: () => FSWatcher | null;
  setWatcher: (w: FSWatcher) => void;
}

export async function vaultRoutes(app: FastifyInstance, opts: VaultRoutesCtx) {
  const { repo, getWatcher, setWatcher } = opts;

  app.get('/vaults', async () => ({ vaults: listVaults(), active: getActiveVault() }));

  app.get('/vaults/active', async () => ({ active: getActiveVault() }));

  app.get('/vault-settings', async () => ({ settings: await getVaultSettings() }));

  app.patch<{ Body: Partial<VaultSettings> }>('/vault-settings', async (req, reply) => {
    if (!req.body || typeof req.body !== 'object') {
      return reply.code(400).send({ error: 'body required' });
    }
    const next = await patchVaultSettings(req.body);
    return { settings: next };
  });

  app.post<{ Body: { path: string; name?: string } }>('/vaults', async (req, reply) => {
    const { path, name } = req.body ?? {};
    if (!path || typeof path !== 'string') {
      return reply.code(400).send({ error: 'path required' });
    }
    try {
      const entry = await registerVault(path, name);
      return { vault: entry };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>('/vaults/:id', async (req, reply) => {
    try {
      const { removed, newActive } = await unregisterVault(req.params.id);
      // 如果删除的是当前 active 且有 fallback，自动 switch 过去
      if (newActive) {
        await performSwitch(newActive.id, repo, getWatcher, setWatcher, app);
      }
      return { removed, switchedTo: newActive };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * Index 重建：truncate SQLite + 全 vault 重扫。
   * 用于 .md 文件被外部工具改坏 / SQLite 损坏 / 元数据漂移等场景。
   */
  /* ---- Backups ---- */
  app.get('/backups', async () => ({ entries: await listBackups() }));

  app.post('/backups', async () => {
    const fileName = await createBackup();
    return { fileName };
  });

  app.post<{ Params: { fileName: string } }>(
    '/backups/:fileName/restore',
    async (req, reply) => {
      try {
        await restoreBackup(decodeURIComponent(req.params.fileName));
        // 还原后立即重扫
        repo.truncateAll();
        await scanVault(config.vaultPath, repo);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.delete<{ Params: { fileName: string } }>(
    '/backups/:fileName',
    async (req) => {
      await purgeBackup(decodeURIComponent(req.params.fileName));
      return { ok: true };
    },
  );

  app.post('/vault-settings/rebuild-index', async (_req, _reply) => {
    const t0 = Date.now();
    repo.truncateAll();
    let count = 0;
    try {
      count = await scanVault(config.vaultPath, repo);
    } catch (err) {
      app.log.warn({ err }, 'rebuild-index scan failed');
    }
    return { ok: true, cards: count, durationMs: Date.now() - t0 };
  });

  app.post<{ Body: { id: string } }>('/vaults/switch', async (req, reply) => {
    const { id } = req.body ?? {};
    if (!id) return reply.code(400).send({ error: 'id required' });
    try {
      const result = await performSwitch(id, repo, getWatcher, setWatcher, app);
      return result;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}

async function performSwitch(
  id: string,
  repo: CardRepository,
  getWatcher: () => FSWatcher | null,
  setWatcher: (w: FSWatcher) => void,
  app: FastifyInstance,
): Promise<{ active: ReturnType<typeof getActiveVault>; cards: number; durationMs: number }> {
  const t0 = Date.now();
  // 1. 停旧 watcher（防止扫描时被 watcher 触发覆盖）
  await getWatcher()?.close();
  // 2. 清所有 in-memory cache
  resetWorkspacesCache();
  resetPositionsCache();
  resetStarredCache();
  resetVaultSettingsCache();
  // 3. 清 SQLite 全表
  repo.truncateAll();
  // 4. 切 active vault path（同时 setActiveVaultPath，所以 config.vaultPath 立刻是新值）
  await setActiveVaultId(id);
  // 5. 确保 attachments 目录存在
  await mkdir(join(config.vaultPath, 'attachments'), { recursive: true });
  // 6. 扫新 vault
  app.log.info(`switching vault to: ${config.vaultPath}`);
  try {
    await scanVault(config.vaultPath, repo);
  } catch (err) {
    app.log.warn({ err }, 'vault scan after switch failed');
  }
  // 7. 起新 watcher
  setWatcher(watchVault(config.vaultPath, repo));
  // 8. 重启 backup scheduler（新 vault 的 settings 决定是否启用）
  startBackupScheduler();
  return {
    active: getActiveVault(),
    cards: repo.count(),
    durationMs: Date.now() - t0,
  };
}
