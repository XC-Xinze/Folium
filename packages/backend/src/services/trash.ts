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
      const parsed = matter(raw, {});
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

export type RestoreStrategy = 'fail' | 'next-available' | 'replace';

/** 把 trash 里某文件还原到 vault 根目录。
 *
 * conflict 处理（strategy 参数）：
 *  - 'fail'           → 旧 id 已存在就报错（默认；前端先 dryRun 探测）
 *  - 'next-available' → 改用 next-available 新 id（如 2a 占了就还原成 2c），返回新 id
 *  - 'replace'        → 把现有 id 那张卡的当前内容写到 trash，然后用还原的覆盖（互换位置）
 */
export async function restoreFromTrash(
  repo: CardRepository,
  fileName: string,
  strategy: RestoreStrategy = 'fail',
): Promise<{ luhmannId: string; conflict?: boolean; replacedExisting?: boolean }> {
  const src = join(TRASH_DIR(), fileName);
  const raw = await readFile(src, 'utf8');
  const parsed = matter(raw, {});
  const originalId =
    (typeof parsed.data.luhmannId === 'string' && parsed.data.luhmannId) ||
    fileName.replace(/^\d{8}T\d{6}-/, '').replace(/\.md$/, '');

  // 探测冲突
  let conflict = false;
  try {
    await stat(join(config.vaultPath, `${originalId}.md`));
    conflict = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  if (!conflict) {
    // 无冲突 → 还原原 id
    const dst = join(config.vaultPath, `${originalId}.md`);
    await rename(src, dst);
    const card = await parseCardFile(dst);
    if (card) repo.upsertOne(card);
    return { luhmannId: originalId };
  }

  // 有冲突
  if (strategy === 'fail') {
    throw new Error(
      `A card with id "${originalId}" already exists. Pass strategy='next-available' to restore under a free id, or strategy='replace' to swap the current one into trash.`,
    );
  }

  if (strategy === 'next-available') {
    // 算 next-available 子 id：用原 id 的 parent 推（无 parent 就走顶级数字）
    const allIds = new Set(repo.list().map((c) => c.luhmannId));
    const lastChar = originalId.at(-1);
    const parentId = lastChar
      ? originalId.replace(/(\d+|[a-z]+)$/i, '')
      : '';
    const newId = computeNextAvailableId(parentId, allIds);
    if (!newId) throw new Error('Could not find a free id');

    // rewrite frontmatter luhmannId + 把内容里 [[oldId]] 自引用也改掉（罕见但可能）
    parsed.data.luhmannId = newId;
    const rewrittenRaw = matter.stringify(parsed.content, parsed.data);
    const dst = join(config.vaultPath, `${newId}.md`);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(dst, rewrittenRaw, 'utf8');
    await unlink(src);
    const card = await parseCardFile(dst);
    if (card) repo.upsertOne(card);
    return { luhmannId: newId, conflict: true };
  }

  // strategy === 'replace'
  // 把现有那张卡先送进 trash，再把还原的写回原位
  const existingPath = join(config.vaultPath, `${originalId}.md`);
  const existingRaw = await readFile(existingPath, 'utf8');
  const ts =
    new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const trashPath = join(TRASH_DIR(), `${ts}-${originalId}.md`);
  const { writeFile } = await import('node:fs/promises');
  await mkdir(TRASH_DIR(), { recursive: true });
  await writeFile(trashPath, existingRaw, 'utf8');
  await unlink(existingPath);
  await rename(src, existingPath);
  const card = await parseCardFile(existingPath);
  if (card) repo.upsertOne(card);
  return { luhmannId: originalId, conflict: true, replacedExisting: true };
}

/** 算 parent 下一个可用子 id（跟 routes/cards.ts 的 next-child-id 同算法） */
function computeNextAvailableId(parentId: string, allIds: Set<string>): string | null {
  if (!parentId) {
    for (let n = 1; n < 100000; n++) {
      const c = String(n);
      if (!allIds.has(c)) return c;
    }
    return null;
  }
  const lastChar = parentId.at(-1)!;
  const nextIsDigit = !/\d/.test(lastChar);
  if (nextIsDigit) {
    for (let i = 1; i < 100000; i++) {
      const c = parentId + i;
      if (!allIds.has(c)) return c;
    }
  } else {
    for (let i = 0; i < 26; i++) {
      const c = parentId + String.fromCharCode(97 + i);
      if (!allIds.has(c)) return c;
    }
  }
  return null;
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
