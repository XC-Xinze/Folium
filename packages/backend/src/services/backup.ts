/**
 * Vault 自动备份：把 vault 目录（除 .zettel/backups 自身外）压成 zip 存到
 * `<vault>/.zettel/backups/<timestamp>.zip`，按 vault settings 配置的频率/保留份数。
 *
 * 触发时机：
 *   1. 启动时检查上次备份时间，超过 interval 立刻跑一份
 *   2. 之后内置 setInterval 周期跑（频率取 settings.backupIntervalHours）
 *
 * 还原：从 .zettel/backups/X.zip 解压覆盖到 vault 根，先把当前 vault 自身打一份"pre-restore"
 * 备份兜底，避免还原结果不如预期还能撤回。
 */
import { mkdir, readdir, stat, unlink, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { config } from '../config.js';
import { getVaultSettings } from './vaultSettings.js';
import { assertSafeFileName, resolveInside } from '../security/pathGuards.js';

const BACKUP_DIR = () => join(config.vaultPath, '.zettel', 'backups');
const ZETTEL_BACKUPS_REL = '.zettel/backups';

export interface BackupEntry {
  fileName: string;
  size: number;
  createdAt: string;
}

function backupFilename(prefix = ''): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  return `${prefix}${ts}.zip`;
}

/** 立即备份一份，返回新备份的文件名 */
export async function createBackup(prefix = ''): Promise<string> {
  const dir = BACKUP_DIR();
  await mkdir(dir, { recursive: true });
  const fileName = backupFilename(prefix);
  const fp = join(dir, fileName);
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(fp);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(out);
    // glob 整个 vault 但排除 .zettel/backups（避免循环）和已有 zip
    archive.glob('**/*', {
      cwd: config.vaultPath,
      ignore: [`${ZETTEL_BACKUPS_REL}/**`],
      dot: true, // 包括 .zettel 等隐藏目录
    });
    archive.finalize();
  });
  await pruneOldBackups();
  return fileName;
}

/** 列已存在备份 */
export async function listBackups(): Promise<BackupEntry[]> {
  const dir = BACKUP_DIR();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: BackupEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.zip')) continue;
    try {
      const s = await stat(join(dir, f));
      const tsMatch = f.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
      const createdAt = tsMatch
        ? `${tsMatch[1]}-${tsMatch[2]}-${tsMatch[3]}T${tsMatch[4]}:${tsMatch[5]}:${tsMatch[6]}Z`
        : new Date(s.mtimeMs).toISOString();
      out.push({ fileName: f, size: s.size, createdAt });
    } catch {}
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 按 keep N 修剪老备份 */
async function pruneOldBackups(): Promise<void> {
  const settings = await getVaultSettings();
  const keep = settings.backupKeep;
  const list = await listBackups();
  if (list.length <= keep) return;
  for (const e of list.slice(keep)) {
    await unlink(join(BACKUP_DIR(), e.fileName)).catch(() => undefined);
  }
}

/** 还原备份：解压到 vault 根。先把当前 vault 自动 pre-restore 备一份兜底 */
export async function restoreBackup(fileName: string): Promise<{ ok: true }> {
  const safeName = assertSafeFileName(fileName, '.zip');
  const fp = join(BACKUP_DIR(), safeName);
  // 1. 确认存在
  await stat(fp);
  // 2. 当前 vault 先备一份 pre-restore（即使还原失败也能撤回）
  await createBackup('pre-restore-');
  // 3. 解压覆盖
  // 用 readFile + unzipper.Open.buffer 避免 stream 解压 fs 错误
  const buf = await readFile(fp);
  const directory = await unzipper.Open.buffer(buf);
  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;
    const dest = resolveInside(config.vaultPath, entry.path);
    await mkdir(dirname(dest), { recursive: true });
    const data = await entry.buffer();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(dest, data);
  }
  return { ok: true };
}

export async function purgeBackup(fileName: string): Promise<void> {
  const safeName = assertSafeFileName(fileName, '.zip');
  await unlink(join(BACKUP_DIR(), safeName)).catch(() => undefined);
}

/* ============================================================
 * 自动备份调度
 * ============================================================ */
let timer: NodeJS.Timeout | null = null;

/**
 * 检查当前是否到了该备份的时机；启动时调一次，之后定时轮询。
 * - settings.backupEnabled === false 直接 noop
 * - 跟上一次备份时间间隔 < interval 也 noop
 */
async function maybeRunBackup(): Promise<void> {
  const settings = await getVaultSettings();
  if (!settings.backupEnabled) return;
  const list = await listBackups();
  const last = list[0];
  const intervalMs = settings.backupIntervalHours * 60 * 60 * 1000;
  if (last && Date.now() - new Date(last.createdAt).getTime() < intervalMs) return;
  try {
    await createBackup();
    console.log('[backup] auto backup created');
  } catch (err) {
    console.error('[backup] auto backup failed:', err);
  }
}

/** 启动时调；vault switch 时也调一次（先停旧 timer 再起新） */
export function startBackupScheduler(): void {
  stopBackupScheduler();
  // 启动时立刻判一次（最多产生一份"启动备份"）
  void maybeRunBackup();
  // 之后每小时检查一次（实际备份与否由 maybeRunBackup 内部决定）
  timer = setInterval(() => {
    void maybeRunBackup();
  }, 60 * 60 * 1000);
}

export function stopBackupScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
