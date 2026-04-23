import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import { config } from '../config.js';
import { CardRepository } from '../vault/repository.js';
import {
  parseSegments,
  segmentsToCanonical,
  sortKey,
  deriveParentIdFn,
  type Segment,
} from '../vault/luhmann.js';
import { renameCardInAllScopes } from './positions.js';
import { walkMd } from '../vault/scanner.js';
import { parseCardFile } from '../vault/parser.js';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ============================================================
 * Promote / Demote 命名计算
 * ============================================================ */

type IdResult = { ok: true; newId: string } | { ok: false; error: string };

/**
 * 提权：把卡片移到父级所在的层级（成为父级的兄弟）。
 *
 * 规则（按父级最后一段类型分支）：
 *   - 父级以字母结尾（如 1a）→ 加字母后缀做"标记"（1a → 1aa, 1ab, ...）
 *     这种命名能保留"从 1a 提上来"的语义
 *   - 父级以数字结尾（如 1a2）→ 在祖父下找下一个空数字位（1a3, 1a4, ...）
 *   - 没有祖父（父就是顶层）→ 在最顶层加新的同类型段（i → j; 1 → 4）
 */
export function computePromotedId(oldId: string, existingIds: Set<string>): IdResult {
  const segs = parseSegments(oldId);
  if (segs.length < 2) {
    return { ok: false, error: '顶层卡无法提权（已经在最顶）' };
  }

  const parentId = deriveParentIdFn(oldId);
  if (!parentId) return { ok: false, error: '找不到父级' };
  const parentSegs = parseSegments(parentId);
  const lastParentSeg = parentSegs[parentSegs.length - 1]!;
  const grandparentId = deriveParentIdFn(parentId); // 可能为 null（父级是顶层）

  if (lastParentSeg.kind === 'alpha') {
    // 标记式：父级 + 字母
    for (let i = 0; i < 26; i++) {
      const ch = String.fromCharCode('a'.charCodeAt(0) + i);
      const candidate = parentId + ch;
      if (!existingIds.has(candidate)) return { ok: true, newId: candidate };
    }
    return { ok: false, error: '所有 a-z 标记后缀都已被占用' };
  }

  // 父级以数字结尾：在祖父下找下一个数字位
  const startN = lastParentSeg.value + 1;
  if (grandparentId === null) {
    // 父级是顶层数字段（如 1），找下一个顶层数字
    for (let i = startN; i < startN + 1000; i++) {
      const candidate = String(i);
      if (!existingIds.has(candidate)) return { ok: true, newId: candidate };
    }
  } else {
    // 父级是中间层数字段（如 1a2），祖父末尾必为字母（如 1a），新位是 1aN
    for (let i = startN; i < startN + 1000; i++) {
      const candidate = grandparentId + String(i);
      if (!existingIds.has(candidate)) return { ok: true, newId: candidate };
    }
  }
  return { ok: false, error: '找不到可用的提权位置' };
}

/**
 * 降权：把卡片移到下一个兄弟之下，成为它的子节点。
 *   策略：找 sortKey 排序后的"下一个兄弟"，把卡片塞到它下面。
 *   如果没有兄弟卡片（在父下唯一），无法降权（没有可用的"宿主"）。
 */
export function computeDemotedId(
  oldId: string,
  existingIds: Set<string>,
  allIds: string[],
): (IdResult & { newParent?: string }) {
  const parentId = deriveParentIdFn(oldId);
  // 找 siblings：同 parent
  const siblings = allIds.filter(
    (id) => id !== oldId && deriveParentIdFn(id) === parentId,
  );
  if (siblings.length === 0) {
    return { ok: false, error: '没有兄弟卡片可作为宿主，无法降权' };
  }

  // 按 sortKey 排序，找比 oldId 大的第一个；都没有就回环到第一个
  const oldKey = sortKey(oldId);
  const sorted = siblings.slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const newParent = sorted.find((s) => sortKey(s).localeCompare(oldKey) > 0) ?? sorted[0]!;

  // 在 newParent 下找下一个空位
  const parentSegs = parseSegments(newParent);
  const parentLastSeg = parentSegs[parentSegs.length - 1]!;
  if (parentLastSeg.kind === 'alpha') {
    // 子段必须是数字
    for (let i = 1; i < 10000; i++) {
      const candidate = newParent + String(i);
      if (!existingIds.has(candidate)) return { ok: true, newId: candidate, newParent };
    }
  } else {
    // 子段必须是字母
    for (let i = 0; i < 26; i++) {
      const ch = String.fromCharCode('a'.charCodeAt(0) + i);
      const candidate = newParent + ch;
      if (!existingIds.has(candidate)) return { ok: true, newId: candidate, newParent };
    }
  }
  return { ok: false, error: '找不到可用的降权位置' };
}

/* ============================================================
 * 子树重命名（promote/demote 共用）
 * ============================================================ */

function flipSuffix(suffix: Segment[], firstShouldBe: 'num' | 'alpha'): Segment[] {
  let nextShouldBe = firstShouldBe;
  const result: Segment[] = [];
  for (const seg of suffix) {
    if (seg.kind === nextShouldBe) {
      result.push(seg);
    } else if (nextShouldBe === 'num' && seg.kind === 'alpha') {
      const ch = seg.value[0]!;
      const code = ch.charCodeAt(0) - 'a'.charCodeAt(0) + 1;
      if (code < 1 || code > 26 || seg.value.length > 1) {
        throw new Error(`无法把字母段 "${seg.value}" 映射成单数字（要求 a-z 单字符）`);
      }
      result.push({ kind: 'num', value: code });
    } else if (nextShouldBe === 'alpha' && seg.kind === 'num') {
      if (seg.value < 1 || seg.value > 26) {
        throw new Error(`无法把数字段 ${seg.value} 映射成单字母（要求 1-26）`);
      }
      result.push({
        kind: 'alpha',
        value: String.fromCharCode('a'.charCodeAt(0) + seg.value - 1),
      });
    }
    nextShouldBe = nextShouldBe === 'num' ? 'alpha' : 'num';
  }
  return result;
}

function computeRenameMap(
  originalRoot: string,
  newRoot: string,
  descendants: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  result.set(originalRoot, newRoot);

  const originalRootSegs = parseSegments(originalRoot);
  const newRootSegs = parseSegments(newRoot);
  const newLastSeg = newRootSegs[newRootSegs.length - 1]!;
  const firstSuffixShouldBe: 'num' | 'alpha' = newLastSeg.kind === 'alpha' ? 'num' : 'alpha';

  for (const desc of descendants) {
    const descSegs = parseSegments(desc);
    const suffix = descSegs.slice(originalRootSegs.length);
    const flipped = flipSuffix(suffix, firstSuffixShouldBe);
    const newId = newRoot + segmentsToCanonical(flipped);
    result.set(desc, newId);
  }
  return result;
}

function isDescendantOf(child: string, ancestor: string): boolean {
  if (child === ancestor) return false;
  const childSegs = parseSegments(child);
  const ancestorSegs = parseSegments(ancestor);
  if (childSegs.length <= ancestorSegs.length) return false;
  for (let i = 0; i < ancestorSegs.length; i++) {
    const a = ancestorSegs[i]!;
    const c = childSegs[i]!;
    if (a.kind !== c.kind) return false;
    if (a.kind === 'num' && c.kind === 'num' && a.value !== c.value) return false;
    if (a.kind === 'alpha' && c.kind === 'alpha' && a.value !== c.value) return false;
  }
  return true;
}

export interface RenameResult {
  oldId: string;
  newId: string;
  renamed: number;
  filesUpdated: number;
}

/**
 * 通用子树重命名：把 oldId 改成 newId，子孙按交替规则跟着改。
 * 处理：文件改名、frontmatter 更新、其他文件 [[link]]/crossLinks 替换、位置迁移、DB 更新。
 */
async function renameSubtree(
  db: Database.Database,
  repo: CardRepository,
  cardId: string,
  newId: string,
): Promise<RenameResult> {
  const card = repo.getById(cardId);
  if (!card) throw new Error(`card not found: ${cardId}`);
  if (cardId === newId) {
    return { oldId: cardId, newId, renamed: 0, filesUpdated: 0 };
  }

  const allCards = repo.list();
  const allIds = allCards.map((c) => c.luhmannId);
  const descendants = allIds.filter((id) => isDescendantOf(id, cardId));
  const renameMap = computeRenameMap(cardId, newId, descendants);

  // 验证
  const renamedSources = new Set(renameMap.keys());
  const newIds = new Set(renameMap.values());
  for (const id of allIds) {
    if (renamedSources.has(id)) continue;
    if (newIds.has(id)) {
      throw new Error(`重命名后会与现有卡 "${id}" 冲突`);
    }
  }
  if (newIds.size !== renameMap.size) {
    throw new Error('级联重命名出现内部 ID 冲突');
  }

  const today = new Date().toISOString().slice(0, 10);
  const linkReFor = (oid: string) =>
    new RegExp(`\\[\\[\\s*${escapeRe(oid)}\\s*(\\|[^\\]]+)?\\s*\\]\\]`, 'g');

  // 写新文件
  const oldPaths: string[] = [];
  for (const [oldId, newCardId] of renameMap) {
    const oldRow = repo.getById(oldId);
    if (!oldRow) continue;
    const oldPath = oldRow.filePath;
    const newPath = join(dirname(oldPath), `${newCardId}.md`);
    const raw = await readFile(oldPath, 'utf8');
    const parsed = matter(raw);
    parsed.data.luhmannId = newCardId;
    parsed.data.updated = today;
    if (Array.isArray(parsed.data.crossLinks)) {
      parsed.data.crossLinks = parsed.data.crossLinks.map((x: unknown) => {
        const s = String(x);
        return renameMap.get(s) ?? s;
      });
    }
    let body = parsed.content;
    for (const [oid, nid] of renameMap) {
      body = body.replace(linkReFor(oid), (_m, alias?: string) => `[[${nid}${alias ?? ''}]]`);
    }
    await writeFile(newPath, matter.stringify(body, parsed.data), 'utf8');
    if (newPath !== oldPath) oldPaths.push(oldPath);
  }

  // 删旧文件
  for (const p of oldPaths) {
    try {
      await unlink(p);
    } catch {}
  }

  // 其他文件的引用更新
  let filesUpdated = 0;
  const allRenamedSourceBases = new Set([...renameMap.keys()]);
  const allRenamedTargetBases = new Set([...renameMap.values()]);
  for await (const file of walkMd(config.vaultPath)) {
    const base = basename(file, '.md');
    if (allRenamedSourceBases.has(base) || allRenamedTargetBases.has(base)) continue;
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const p = matter(content);
    let changed = false;
    if (Array.isArray(p.data.crossLinks)) {
      const updated = p.data.crossLinks.map((x: unknown) => {
        const s = String(x);
        const renamed = renameMap.get(s);
        if (renamed) {
          changed = true;
          return renamed;
        }
        return x;
      });
      p.data.crossLinks = updated;
    }
    let body = p.content;
    for (const [oid, nid] of renameMap) {
      const re = linkReFor(oid);
      const newBody = body.replace(re, (_m, alias?: string) => {
        changed = true;
        return `[[${nid}${alias ?? ''}]]`;
      });
      body = newBody;
    }
    if (changed) {
      await writeFile(file, matter.stringify(body, p.data), 'utf8');
      filesUpdated += 1;
    }
  }

  // 位置迁移
  for (const [oid, nid] of renameMap) {
    await renameCardInAllScopes(oid, nid);
  }

  // DB 更新
  for (const oid of renameMap.keys()) {
    db.prepare(`DELETE FROM cards WHERE luhmann_id = ?`).run(oid);
  }
  for await (const file of walkMd(config.vaultPath)) {
    const c = await parseCardFile(file);
    if (c) repo.upsertOne(c);
  }

  return { oldId: cardId, newId, renamed: renameMap.size, filesUpdated };
}

/* ============================================================
 * 公开 API
 * ============================================================ */

export async function promoteCard(
  db: Database.Database,
  repo: CardRepository,
  cardId: string,
): Promise<RenameResult> {
  const allCards = repo.list();
  const compute = computePromotedId(cardId, new Set(allCards.map((c) => c.luhmannId)));
  if (!compute.ok) throw new Error(compute.error);
  return renameSubtree(db, repo, cardId, compute.newId);
}

export async function demoteCard(
  db: Database.Database,
  repo: CardRepository,
  cardId: string,
): Promise<RenameResult> {
  const allCards = repo.list();
  const ids = allCards.map((c) => c.luhmannId);
  const compute = computeDemotedId(cardId, new Set(ids), ids);
  if (!compute.ok) throw new Error(compute.error);
  return renameSubtree(db, repo, cardId, compute.newId);
}
