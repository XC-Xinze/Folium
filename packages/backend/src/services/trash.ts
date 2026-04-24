import { mkdir, readdir, readFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { config } from '../config.js';
import type { CardRepository } from '../vault/repository.js';
import { parseCardFile } from '../vault/parser.js';

const TRASH_DIR = () => join(config.vaultPath, '.zettel', 'trash');

export interface TrashEntry {
  /** 文件名（不含路径），可作 ID 用 */
  fileName: string;
  /** 原 luhmannId（从文件名 timestamp-{id}.md 解析或 frontmatter） */
  luhmannId: string;
  /** 原标题 */
  title: string;
  /** 删除时间 ISO */
  deletedAt: string;
  /** 文件 mtime（备用） */
  mtime: number;
}

/** 列出回收站里所有文件 */
export async function listTrash(): Promise<TrashEntry[]> {
  const dir = TRASH_DIR();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: TrashEntry[] = [];
  for (const fname of files) {
    if (!fname.endsWith('.md')) continue;
    const fp = join(dir, fname);
    try {
      const raw = await readFile(fp, 'utf8');
      const parsed = matter(raw);
      const luhmannId =
        (typeof parsed.data.luhmannId === 'string' && parsed.data.luhmannId) ||
        // fallback: 从文件名 timestamp-{id}.md 提取
        fname.replace(/^\d{8}T\d{6}-/, '').replace(/\.md$/, '');
      const title =
        (typeof parsed.data.title === 'string' && parsed.data.title) || luhmannId;
      // 时间戳解析：20260424T093030 → 2026-04-24T09:30:30Z
      const tsMatch = fname.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
      const deletedAt = tsMatch
        ? `${tsMatch[1]}-${tsMatch[2]}-${tsMatch[3]}T${tsMatch[4]}:${tsMatch[5]}:${tsMatch[6]}Z`
        : new Date((await stat(fp)).mtimeMs).toISOString();
      out.push({
        fileName: fname,
        luhmannId,
        title,
        deletedAt,
        mtime: (await stat(fp)).mtimeMs,
      });
    } catch {
      // 损坏的 markdown 跳过
    }
  }
  // 最近删的在前
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 把 trash 里某文件还原到 vault 根目录 */
export async function restoreFromTrash(
  repo: CardRepository,
  fileName: string,
): Promise<{ luhmannId: string }> {
  const src = join(TRASH_DIR(), fileName);
  // 读 frontmatter 获取 luhmannId 决定还原后的文件名
  const raw = await readFile(src, 'utf8');
  const parsed = matter(raw);
  const id =
    (typeof parsed.data.luhmannId === 'string' && parsed.data.luhmannId) ||
    fileName.replace(/^\d{8}T\d{6}-/, '').replace(/\.md$/, '');
  const dst = join(config.vaultPath, `${id}.md`);
  // 如果目标位置已有同名 → 拒绝，避免覆盖
  try {
    await stat(dst);
    throw new Error(`A card with id "${id}" already exists; rename or delete it first.`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await rename(src, dst);
  // 立即 reindex
  const card = await parseCardFile(dst);
  if (card) repo.upsertOne(card);
  return { luhmannId: id };
}

/** 永久删除 trash 里某文件 */
export async function purgeTrashEntry(fileName: string): Promise<void> {
  await unlink(join(TRASH_DIR(), fileName));
}

/** 清空 trash */
export async function emptyTrash(): Promise<{ purged: number }> {
  const dir = TRASH_DIR();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return { purged: 0 };
  }
  let purged = 0;
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    try {
      await unlink(join(dir, f));
      purged += 1;
    } catch {
      // skip
    }
  }
  return { purged };
}
