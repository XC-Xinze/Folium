/**
 * Vault registry：用户机器上注册过的 vault 列表 + 当前激活的那个。
 * 跟 backend 进程持久化无关 —— 存在 ~/.zettelkasten/config.json，跨重启保留。
 *
 * 形态：
 *   {
 *     "vaults": [{ "id": "v_abc123", "path": "/Users/x/Notes", "name": "Personal" }, ...],
 *     "activeVaultId": "v_abc123"
 *   }
 *
 * 启动时若 config 不存在或为空，开发模式会用 example-vault seed；
 * 打包版不 seed example，让用户先选择自己的 vault。
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, basename, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { getActiveVaultPath, setActiveVaultPath } from '../config.js';

export interface VaultEntry {
  id: string;
  path: string;
  name: string;
}

interface RegistryFile {
  vaults: VaultEntry[];
  activeVaultId: string | null;
}

const CONFIG_PATH = process.env.FOLIUM_CONFIG_DIR
  ? join(resolve(process.env.FOLIUM_CONFIG_DIR.replace(/^~/, homedir())), 'config.json')
  : join(homedir(), '.folium', 'config.json');
const LEGACY_CONFIG_PATH = join(homedir(), '.zettelkasten', 'config.json');
const disableExampleVault = process.env.FOLIUM_DISABLE_EXAMPLE_VAULT === '1';

let cache: RegistryFile | null = null;

function emptyRegistry(): RegistryFile {
  return { vaults: [], activeVaultId: null };
}

function newId(): string {
  return 'v_' + randomBytes(6).toString('hex');
}

function expandHome(p: string): string {
  return resolve(p.replace(/^~/, homedir()));
}

async function loadFromDisk(): Promise<RegistryFile> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as RegistryFile;
    if (!parsed.vaults || !Array.isArray(parsed.vaults)) return emptyRegistry();
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        const raw = await readFile(LEGACY_CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw) as RegistryFile;
        if (!parsed.vaults || !Array.isArray(parsed.vaults)) return emptyRegistry();
        return parsed;
      } catch (legacyErr) {
        if ((legacyErr as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry();
        throw legacyErr;
      }
    }
    throw err;
  }
}

async function saveToDisk(reg: RegistryFile): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(reg, null, 2), 'utf8');
}

async function ensureVaultStructure(path: string): Promise<void> {
  await mkdir(join(path, 'attachments'), { recursive: true });
  await mkdir(join(path, '.zettel'), { recursive: true });
}

/**
 * 启动时调一次：读 config，若空就用 VAULT_PATH seed，并把 activeVaultPath 同步到那个。
 * 之后所有 read 都走 cache，write 都同步落盘。
 */
export async function initVaultRegistry(): Promise<void> {
  const reg = await loadFromDisk();
  if (disableExampleVault) {
    const before = reg.vaults.length;
    reg.vaults = reg.vaults.filter((v) => !/(?:^|[/\\])example-vault[/\\]?$/.test(v.path));
    if (before !== reg.vaults.length && !reg.vaults.find((v) => v.id === reg.activeVaultId)) {
      reg.activeVaultId = reg.vaults[0]?.id ?? null;
    }
  }

  // seed: 没有任何 vault → 把当前 active path 注册成第一个
  if (reg.vaults.length === 0) {
    const path = getActiveVaultPath();
    if (!path) {
      reg.activeVaultId = null;
      cache = reg;
      return;
    }
    await ensureVaultStructure(path);
    const id = newId();
    reg.vaults.push({ id, path, name: basename(path) || 'Vault' });
    reg.activeVaultId = id;
    await saveToDisk(reg);
  } else if (!reg.activeVaultId || !reg.vaults.find((v) => v.id === reg.activeVaultId)) {
    // active 缺失或指向不存在的 id → fallback 到第一个
    reg.activeVaultId = reg.vaults[0]!.id;
    await saveToDisk(reg);
  }

  // 同步 active path 到 config 单例
  const active = reg.vaults.find((v) => v.id === reg.activeVaultId);
  if (active) setActiveVaultPath(active.path);
  if (active) await ensureVaultStructure(active.path);

  cache = reg;
}

export function listVaults(): VaultEntry[] {
  if (!cache) throw new Error('vault registry not initialized');
  return cache.vaults.slice();
}

export function getActiveVault(): VaultEntry | null {
  if (!cache) throw new Error('vault registry not initialized');
  return cache.vaults.find((v) => v.id === cache!.activeVaultId) ?? null;
}

/**
 * 注册一个新 vault。验证路径存在且是目录。返回新条目。
 * 同 path 已注册过则返回已存在的条目（不重复）。
 */
export async function registerVault(rawPath: string, name?: string): Promise<VaultEntry> {
  if (!cache) throw new Error('vault registry not initialized');
  const path = expandHome(rawPath);
  const st = await stat(path).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`Not a directory: ${path}`);
  await ensureVaultStructure(path);

  const existing = cache.vaults.find((v) => v.path === path);
  if (existing) return existing;

  const entry: VaultEntry = {
    id: newId(),
    path,
    name: name?.trim() || basename(path) || 'Vault',
  };
  cache.vaults.push(entry);
  await saveToDisk(cache);
  return entry;
}

/**
 * 注销 vault（不删文件）。如果删除的是当前 active，自动切到列表里第一个剩下的。
 * 返回 { removed, newActive }，newActive 非 null 表示发生了 active 切换，调用方应触发 switch 流程。
 */
export async function unregisterVault(
  id: string,
): Promise<{ removed: VaultEntry; newActive: VaultEntry | null }> {
  if (!cache) throw new Error('vault registry not initialized');
  const idx = cache.vaults.findIndex((v) => v.id === id);
  if (idx < 0) throw new Error(`Vault not found: ${id}`);
  const [removed] = cache.vaults.splice(idx, 1);
  let newActive: VaultEntry | null = null;
  if (cache.activeVaultId === id) {
    newActive = cache.vaults[0] ?? null;
    cache.activeVaultId = newActive?.id ?? null;
  }
  await saveToDisk(cache);
  return { removed: removed!, newActive };
}

/** 设置 active vault；不做 switch 副作用，调用方负责 watcher/scan reset */
export async function setActiveVaultId(id: string): Promise<VaultEntry> {
  if (!cache) throw new Error('vault registry not initialized');
  const v = cache.vaults.find((x) => x.id === id);
  if (!v) throw new Error(`Vault not found: ${id}`);
  cache.activeVaultId = id;
  setActiveVaultPath(v.path);
  await saveToDisk(cache);
  return v;
}
