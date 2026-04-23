import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalize } from './luhmann.js';
import { config } from '../config.js';

export interface NewCardInput {
  luhmannId: string;
  title: string;
  content: string;
  tags?: string[];
  crossLinks?: string[];
  status?: 'ATOMIC' | 'INDEX';
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
  const frontmatter =
    `---\n` +
    `luhmannId: ${id}\n` +
    `title: ${JSON.stringify(input.title)}\n` +
    `status: ${input.status ?? 'ATOMIC'}\n` +
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
