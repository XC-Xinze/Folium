import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import { config } from '../config.js';
import { CardRepository } from '../vault/repository.js';
import {
  parseSegments,
  segmentsToCanonical,
  deriveParentIdFn,
  type Segment,
} from '../vault/luhmann.js';
import { setPosition, deletePosition, loadPositions } from './positions.js';
import { walkMd } from '../vault/scanner.js';
import { parseCardFile } from '../vault/parser.js';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 算提权后的新 luhmannId。
 *   规则：父 ID + 一个字母后缀（'a', 'b', ...），跳过已存在的 ID。
 *   要求：父 ID 必须以字母段结尾（如 1a），新 id 才能合并成连续字母段（1a + a = 1aa, 视为深度 2）。
 */
export function computePromotedId(
  oldId: string,
  existingIds: Set<string>,
): { ok: true; newId: string } | { ok: false; error: string } {
  const segs = parseSegments(oldId);
  if (segs.length < 3) {
    return { ok: false, error: '只能提权深度 ≥ 3 的卡' };
  }
  const parentId = deriveParentIdFn(oldId);
  if (!parentId) return { ok: false, error: '找不到父级' };
  const parentSegs = parseSegments(parentId);
  const lastParentSeg = parentSegs[parentSegs.length - 1];
  if (!lastParentSeg || lastParentSeg.kind !== 'alpha') {
    return { ok: false, error: '父级以数字结尾，目前不支持这种提权' };
  }
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode('a'.charCodeAt(0) + i);
    const candidate = parentId + ch;
    if (!existingIds.has(candidate)) return { ok: true, newId: candidate };
  }
  return { ok: false, error: '所有 a-z 后缀都已用完' };
}

/**
 * 翻转后缀的段类型，让它和新前缀的尾部交替。
 * 把字母段映射成数字（a=1,b=2,...），数字段映射成字母（1=a,2=b,...）。
 *   原 `[a, 1, b]` 在 `aa` 之后 → 第一个段需要数字 → flip 后 `[1, a, 2]`
 */
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
        throw new Error(`无法把字母段 ${seg.value} 映射成单数字（要求 a-z 单字符）`);
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

/** 给定原 root 和新 root，构建整个子树的 oldId → newId 映射 */
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
  // newRoot 尾部是字母 → 后缀第一段需要数字；反之亦然
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

interface PromoteResult {
  oldId: string;
  newId: string;
  renamed: number; // 含子孙
  filesUpdated: number; // 不含被改名的文件
}

/**
 * 执行级联提权：
 *   1. 算新 id 和子孙的 rename map（带类型翻转）
 *   2. 验证不和现存非重命名卡冲突
 *   3. 按映射写新文件 + 更新 frontmatter + 替换正文 [[link]]
 *   4. 删旧文件
 *   5. 更新其他文件的引用
 *   6. 迁移 positions
 *   7. 更新 DB
 */
export async function promoteCard(
  db: Database.Database,
  repo: CardRepository,
  cardId: string,
): Promise<PromoteResult> {
  const card = repo.getById(cardId);
  if (!card) throw new Error(`card not found: ${cardId}`);

  const allCards = repo.list();
  const allIds = allCards.map((c) => c.luhmannId);
  const allIdsSet = new Set(allIds);

  // === 1. 算新 id ===
  const compute = computePromotedId(cardId, allIdsSet);
  if (!compute.ok) throw new Error(compute.error);
  const newId = compute.newId;

  // === 1a. 子孙 + rename map（带类型翻转） ===
  const descendants = allIds.filter((id) => isDescendantOf(id, cardId));
  const renameMap = computeRenameMap(cardId, newId, descendants);

  // === 2. 验证：新 ID 不能撞到任何不在 renameMap 里的现存卡 ===
  const renamedSources = new Set(renameMap.keys());
  const newIds = new Set(renameMap.values());
  for (const id of allIds) {
    if (renamedSources.has(id)) continue;
    if (newIds.has(id)) {
      throw new Error(`提权后会与现有卡 "${id}" 冲突，请先处理`);
    }
  }
  // 同时新 ID 集合内部也不能有重复
  if (newIds.size !== renameMap.size) {
    throw new Error('级联提权出现内部 ID 冲突，请检查子孙编号');
  }

  const today = new Date().toISOString().slice(0, 10);
  const linkReFor = (oid: string) =>
    new RegExp(`\\[\\[\\s*${escapeRe(oid)}\\s*(\\|[^\\]]+)?\\s*\\]\\]`, 'g');

  // === 3. 写新文件（每个 renameMap 条目）===
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
    // 改 crossLinks 中可能引用其他被重命名的卡
    if (Array.isArray(parsed.data.crossLinks)) {
      parsed.data.crossLinks = parsed.data.crossLinks.map((x: unknown) => {
        const s = String(x);
        return renameMap.get(s) ?? s;
      });
    }
    // 改正文里所有可能被重命名的 [[link]]
    let body = parsed.content;
    for (const [oid, nid] of renameMap) {
      body = body.replace(linkReFor(oid), (_m, alias?: string) => `[[${nid}${alias ?? ''}]]`);
    }
    await writeFile(newPath, matter.stringify(body, parsed.data), 'utf8');
    if (newPath !== oldPath) oldPaths.push(oldPath);
  }

  // === 4. 删旧文件 ===
  for (const p of oldPaths) {
    try {
      await unlink(p);
    } catch {
      // 文件可能因为同名 newPath = oldPath 已不存在
    }
  }

  // === 5. 其他卡的引用更新 ===
  let filesUpdated = 0;
  const allRenamedSourceBases = new Set([...renameMap.keys()]);
  const allRenamedTargetBases = new Set([...renameMap.values()]);
  for await (const file of walkMd(config.vaultPath)) {
    const base = basename(file, '.md');
    // 跳过被重命名的文件本身（它们的内容已在 step 3 处理）
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

  // === 6. 迁移 positions ===
  const positions = await loadPositions();
  for (const [oid, nid] of renameMap) {
    if (positions[oid]) {
      const { x, y } = positions[oid];
      await setPosition(nid, x, y);
      await deletePosition(oid);
    }
  }

  // === 7. DB：删旧记录，重扫所有文件 ===
  for (const oid of renameMap.keys()) {
    db.prepare(`DELETE FROM cards WHERE luhmann_id = ?`).run(oid);
  }
  for await (const file of walkMd(config.vaultPath)) {
    const c = await parseCardFile(file);
    if (c) repo.upsertOne(c);
  }

  return { oldId: cardId, newId, renamed: renameMap.size, filesUpdated };
}
