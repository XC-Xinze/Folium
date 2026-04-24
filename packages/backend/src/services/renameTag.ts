import { readFile, writeFile } from 'node:fs/promises';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import { config } from '../config.js';
import { CardRepository } from '../vault/repository.js';
import { walkMd } from '../vault/scanner.js';
import { parseCardFile } from '../vault/parser.js';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function renameTag(
  db: Database.Database,
  repo: CardRepository,
  oldName: string,
  newName: string,
): Promise<{ filesUpdated: number; oldName: string; newName: string }> {
  const oldLower = oldName.toLowerCase().trim();
  const newLower = newName.toLowerCase().trim();
  if (!oldLower || !newLower) throw new Error('tag 名不能为空');
  if (oldLower === newLower) return { filesUpdated: 0, oldName: oldLower, newName: newLower };

  const tagRe = new RegExp(`(?<![一-龥\\w])#${escapeRe(oldLower)}\\b`, 'gi');

  let filesUpdated = 0;
  for await (const file of walkMd(config.vaultPath)) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = matter(raw);
    let changed = false;

    // frontmatter.tags
    if (Array.isArray(parsed.data.tags)) {
      const old = parsed.data.tags.map((t: unknown) => String(t).toLowerCase());
      const next: string[] = [];
      for (const t of old) {
        const v = t === oldLower ? newLower : t;
        if (!next.includes(v)) next.push(v);
      }
      if (JSON.stringify(old) !== JSON.stringify(next)) {
        parsed.data.tags = next;
        changed = true;
      }
    }

    // 正文 inline #oldname
    const newBody = parsed.content.replace(tagRe, () => {
      changed = true;
      return `#${newLower}`;
    });

    if (changed) {
      await writeFile(file, matter.stringify(newBody, parsed.data), 'utf8');
      filesUpdated += 1;
    }
  }

  // 重新扫所有文件入库
  for await (const file of walkMd(config.vaultPath)) {
    const c = await parseCardFile(file);
    if (c) repo.upsertOne(c);
  }
  void db;

  return { filesUpdated, oldName: oldLower, newName: newLower };
}

/**
 * 删除一个 tag——把所有卡片 frontmatter.tags 里和正文 #tag 中的它都剥掉。
 * 卡片本身不动。
 */
export async function deleteTag(
  db: Database.Database,
  repo: CardRepository,
  name: string,
): Promise<{ filesUpdated: number; name: string }> {
  const lower = name.toLowerCase().trim();
  if (!lower) throw new Error('tag 名不能为空');

  const tagRe = new RegExp(`(?<![一-龥\\w])#${escapeRe(lower)}\\b`, 'gi');

  let filesUpdated = 0;
  for await (const file of walkMd(config.vaultPath)) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = matter(raw);
    let changed = false;

    // frontmatter.tags 里去掉
    if (Array.isArray(parsed.data.tags)) {
      const before = parsed.data.tags.map((t: unknown) => String(t).toLowerCase());
      const after = before.filter((t) => t !== lower);
      if (after.length !== before.length) {
        parsed.data.tags = after;
        changed = true;
      }
    }

    // 正文里 #tag 去掉（含可能跟在它后面的一个空格，避免留空 #）
    const newBody = parsed.content.replace(tagRe, () => {
      changed = true;
      return '';
    });

    if (changed) {
      await writeFile(file, matter.stringify(newBody, parsed.data), 'utf8');
      filesUpdated += 1;
    }
  }

  // 重新扫所有文件入库
  for await (const file of walkMd(config.vaultPath)) {
    const c = await parseCardFile(file);
    if (c) repo.upsertOne(c);
  }
  void db;

  return { filesUpdated, name: lower };
}
