import { readFile, writeFile } from 'node:fs/promises';
import type { CardRepository } from '../vault/repository.js';
import { parseCardFile } from '../vault/parser.js';
import matter from 'gray-matter';

export interface SearchReplaceInput {
  query: string;
  replacement: string;
  useRegex?: boolean;
  caseSensitive?: boolean;
  /** 仅在正文里替换；不动 frontmatter（默认 true） */
  bodyOnly?: boolean;
  /** 不写盘，只返回会发生哪些改变 */
  dryRun?: boolean;
}

export interface ChangePreview {
  luhmannId: string;
  title: string;
  count: number;
  /** 第一处命中的上下文片段（前后各 30 字） */
  preview: string;
}

export interface SearchReplaceResult {
  changes: ChangePreview[];
  totalCount: number;
  filesUpdated: number;
}

function buildPattern(input: SearchReplaceInput): RegExp {
  const flags = input.caseSensitive ? 'g' : 'gi';
  if (input.useRegex) return new RegExp(input.query, flags);
  // literal: escape regex 元字符
  const esc = input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc, flags);
}

function makePreview(text: string, match: RegExpMatchArray): string {
  const idx = match.index ?? 0;
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + match[0].length + 30);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

export async function runSearchReplace(
  repo: CardRepository,
  input: SearchReplaceInput,
): Promise<SearchReplaceResult> {
  if (!input.query) return { changes: [], totalCount: 0, filesUpdated: 0 };

  let pattern: RegExp;
  try {
    pattern = buildPattern(input);
  } catch (err) {
    throw new Error(`bad regex: ${(err as Error).message}`);
  }

  const cards = repo.list();
  const changes: ChangePreview[] = [];
  let totalCount = 0;
  let filesUpdated = 0;

  for (const card of cards) {
    const raw = await readFile(card.filePath, 'utf8').catch(() => null);
    if (raw === null) continue;
    const parsed = matter(raw);
    const target = input.bodyOnly === false ? raw : parsed.content;

    // count + first preview
    const matches = [...target.matchAll(pattern)];
    if (matches.length === 0) continue;
    const preview = makePreview(target, matches[0]!);
    changes.push({
      luhmannId: card.luhmannId,
      title: card.title,
      count: matches.length,
      preview,
    });
    totalCount += matches.length;

    if (!input.dryRun) {
      let nextRaw: string;
      if (input.bodyOnly === false) {
        nextRaw = raw.replace(pattern, input.replacement);
      } else {
        const nextBody = parsed.content.replace(pattern, input.replacement);
        nextRaw = matter.stringify(nextBody, parsed.data);
      }
      await writeFile(card.filePath, nextRaw, 'utf8');
      const reparsed = await parseCardFile(card.filePath);
      if (reparsed) repo.upsertOne(reparsed);
      filesUpdated += 1;
    }
  }

  return { changes, totalCount, filesUpdated };
}
