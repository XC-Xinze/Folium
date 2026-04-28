import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import matter from 'gray-matter';
import type { Card, CardStatus } from '../types.js';
import { canonicalize, depth, parentId, sortKey } from './luhmann.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

// 内联标签：#word，要求 # 后跟非空白字符（避免误匹配 markdown 标题 `# Heading`）
// 支持中英文/数字/下划线/连字符
const INLINE_TAG_RE = /(?<![\w一-龥])#([一-龥\w][一-龥\w-]*)/g;

export interface ParsedLinks {
  links: string[];
}

export function extractWikilinks(markdown: string): ParsedLinks {
  const links = new Set<string>();
  for (const match of markdown.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (target) links.add(target);
  }
  return { links: [...links] };
}

export function extractInlineTags(markdown: string): string[] {
  const tags = new Set<string>();
  // 跳过代码块中的内容
  const stripped = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  for (const match of stripped.matchAll(INLINE_TAG_RE)) {
    const tag = match[1]?.trim();
    if (tag) tags.add(tag);
  }
  return [...tags];
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function asStatus(value: unknown): CardStatus {
  if (value === 'INDEX') return 'INDEX';
  // HUB 旧值兼容，silently 映射为 ATOMIC
  return 'ATOMIC';
}

export async function parseCardFile(filePath: string): Promise<Card | null> {
  if (extname(filePath).toLowerCase() !== '.md') return null;

  const raw = await readFile(filePath, 'utf8');
  const stats = await stat(filePath);
  const { data: fm, content: body } = matter(raw);

  // luhmannId: frontmatter 优先，否则用文件名（去 .md）
  const fileBase = basename(filePath, '.md');
  const rawId = (fm.luhmannId ?? fm.id ?? fileBase) as string;
  const luhmannId = canonicalize(String(rawId));
  if (!luhmannId) return null;

  // title: frontmatter 优先，否则用第一个 H1，否则用文件名
  const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = String(fm.title ?? h1 ?? fileBase);

  // tag 大小写不敏感：统一归一为小写，避免 #ML 与 #ml 被当成两个标签
  const tagsFromFm = asStringArray(fm.tags).map((t) => t.toLowerCase());
  const inlineTags = extractInlineTags(body).map((t) => t.toLowerCase());
  const allTags = [...new Set([...tagsFromFm, ...inlineTags])];
  const crossLinksFromFm = asStringArray(fm.crossLinks).map(canonicalize).filter(Boolean);
  const linksFromBody = extractWikilinks(body).links;
  // 合并：crossLinks 字段 + 正文 [[link]]。正文链接保留原始 target，后续按 id/title 解析。
  const allLinks = new Set<string>([...crossLinksFromFm, ...linksFromBody.map((l) => l.trim()).filter(Boolean)]);

  return {
    luhmannId,
    title,
    status: asStatus(fm.status),
    parentId: parentId(luhmannId),
    sortKey: sortKey(luhmannId),
    depth: depth(luhmannId),
    contentMd: body,
    tags: allTags,
    crossLinks: [...allLinks],
    filePath,
    mtime: Math.floor(stats.mtimeMs),
    createdAt: fm.created ? String(fm.created) : null,
    updatedAt: fm.updated ? String(fm.updated) : null,
  };
}
