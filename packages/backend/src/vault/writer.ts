import { writeFile, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { canonicalize } from './luhmann.js';
import { config } from '../config.js';

export interface NewCardInput {
  luhmannId: string;
  title: string;
  content: string;
  tags?: string[];
  crossLinks?: string[];
}

function yamlList(arr: string[] | undefined): string {
  if (!arr || arr.length === 0) return '[]';
  return `[${arr.map((s) => JSON.stringify(s)).join(', ')}]`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function writeNewCard(input: NewCardInput): Promise<{ filePath: string; luhmannId: string }> {
  const id = canonicalize(input.luhmannId);
  if (!id) throw new Error('invalid luhmannId');
  const filePath = join(config.vaultPath, `${id}.md`);

  // 防止覆盖已有卡片
  let exists = false;
  try {
    await access(filePath);
    exists = true;
  } catch {}
  if (exists) throw new Error(`card ${id} already exists`);

  const today = todayIso();
  // status 不写入 frontmatter —— 它是 derived from structure（有 Folgezettel 子卡 = INDEX）
  const frontmatter =
    `---\n` +
    `luhmannId: ${id}\n` +
    `title: ${JSON.stringify(input.title)}\n` +
    `tags: ${yamlList(input.tags)}\n` +
    `crossLinks: ${yamlList(input.crossLinks?.map(canonicalize).filter(Boolean))}\n` +
    `created: ${today}\n` +
    `updated: ${today}\n` +
    `---\n\n` +
    (input.content?.trim() ?? '') +
    '\n';

  await writeFile(filePath, frontmatter, 'utf8');
  return { filePath, luhmannId: id };
}

export interface UpdateCardPatch {
  title?: string;
  content?: string;
  tags?: string[];
}

/**
 * 更新一张卡片的 frontmatter 和/或正文。
 * 不改 luhmannId（如要改 id 用 promote/demote）。
 * status 不接受 patch —— 它是 derived from structure，不是手动设定。
 */
export async function updateCardFile(filePath: string, patch: UpdateCardPatch): Promise<void> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = matter(raw);
  if (patch.title !== undefined) parsed.data.title = patch.title;
  if (patch.tags !== undefined) {
    parsed.data.tags = patch.tags.map((t) => String(t).toLowerCase());
  }
  // 顺手清掉旧文件残留的 status 字段（一次性迁移，写哪改哪）
  if ('status' in parsed.data) delete parsed.data.status;
  parsed.data.updated = todayIso();
  const newContent = patch.content !== undefined ? patch.content : parsed.content;
  await writeFile(filePath, matter.stringify(newContent, parsed.data), 'utf8');
}

