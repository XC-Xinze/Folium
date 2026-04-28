/**
 * 每个 vault 自己的设置，存 `<vault>/.zettel/settings.json`。
 * 跟 `~/.zettelkasten/config.json`（vault registry）分开 —— 后者是机器全局，
 * 这里是 vault 内部偏好（attachment 策略等）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

export interface VaultSettings {
  /** 附件存放策略：
   *  - global：所有附件落到 <vault>/attachments/
   *  - per-box：按当前焦点 box 分子目录 <vault>/attachments/<boxId>/
   *  缺省 global。
   */
  attachmentPolicy: 'global' | 'per-box';
  /** 自动备份开关。默认 true —— 主仓库不知名原因坏了还能从备份恢复。 */
  backupEnabled: boolean;
  /** 自动备份间隔（小时），默认 24 小时一份 */
  backupIntervalHours: number;
  /** 保留最近多少份备份；超出 prune 老的 */
  backupKeep: number;
  /** UI / card typography preferences. Values are CSS font-family stacks. */
  fonts: {
    ui: string;
    body: string;
    display: string;
    mono: string;
  };
}

const DEFAULTS: VaultSettings = {
  attachmentPolicy: 'global',
  backupEnabled: true,
  backupIntervalHours: 24,
  backupKeep: 7,
  fonts: {
    ui: 'Inter',
    body: 'Inter',
    display: 'Newsreader',
    mono: 'JetBrains Mono',
  },
};

const ZETTEL_DIR = '.zettel';
const FILE = 'settings.json';

const dirPath = () => join(config.vaultPath, ZETTEL_DIR);
const filePath = () => join(dirPath(), FILE);

let cache: VaultSettings | null = null;
let cachedFor: string | null = null; // 哪个 vault path 缓存的，切 vault 时检测失效

async function load(): Promise<VaultSettings> {
  const cur = config.vaultPath;
  if (cache && cachedFor === cur) return cache;
  try {
    const raw = await readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<VaultSettings>;
    cache = { ...DEFAULTS, ...parsed, fonts: { ...DEFAULTS.fonts, ...parsed.fonts } };
  } catch {
    cache = { ...DEFAULTS };
  }
  cachedFor = cur;
  return cache;
}

async function save(s: VaultSettings): Promise<void> {
  await mkdir(dirPath(), { recursive: true });
  await writeFile(filePath(), JSON.stringify(s, null, 2), 'utf8');
  cache = s;
  cachedFor = config.vaultPath;
}

export async function getVaultSettings(): Promise<VaultSettings> {
  return load();
}

export async function patchVaultSettings(
  patch: Partial<VaultSettings>,
): Promise<VaultSettings> {
  const cur = await load();
  const next = { ...cur, ...patch };
  await save(next);
  return next;
}

/** vault 切换时调，强制下次 load 重读 */
export function resetVaultSettingsCache(): void {
  cache = null;
  cachedFor = null;
}
