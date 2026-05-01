/**
 * Reparent: 把一张卡（连同它整棵 Folgezettel 子树）挪到另一个父级下，
 * 自动按目标父级算新 id（next available 字母/数字），递归重算所有后代 id。
 *
 * 副作用：
 *   - rename .md 文件（先全部 → 临时名 → 再 → 新名，避免中间冲突）
 *   - rewrite vault 里所有 [[oldId]]（含别名 [[oldId|...]]）→ [[newId]]
 *   - 更新每个被改名卡 frontmatter 的 luhmannId 字段
 *   - 重新 upsert SQLite，清掉 orphan
 *
 * 失败模式：操作不严格 atomic（涉及多文件 IO）。出错时已发生的 rename 不回滚 ——
 * 调用方应在前端做"展示 rename 计划 + 用户确认"。
 */
import type Database from 'better-sqlite3';
import type { CardRepository } from '../vault/repository.js';
import { walkMd } from '../vault/scanner.js';
import { parseCardFile } from '../vault/parser.js';
import { canonicalize, deriveParentIdFn } from '../vault/luhmann.js';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { renameCardInAllScopes } from './positions.js';
import { renameStarred } from './starred.js';
import matter from 'gray-matter';

export interface ReparentResult {
  /** oldId → newId */
  renames: Record<string, string>;
  /** 被改写的 .md 文件数（含改名 + 引用重写） */
  filesUpdated: number;
  /** Workspace canvases whose real-card references were retargeted. */
  workspacesUpdated: number;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Folgezettel 子卡判定：cardId 是 parentId 的直接 Folgezettel 子（剥末尾连续同类后等于 parent） */
function isDirectChild(cardId: string, parentId: string): boolean {
  return deriveParentIdFn(cardId) === parentId;
}

export interface ReparentPlan {
  renames: Map<string, string>;
}

/** 仅算 rename 计划，不动任何 IO；用于前端预览 */
export function planReparent(
  repo: CardRepository,
  sourceId: string,
  newParentId: string | null,
): ReparentPlan {
  const allCards = repo.list();
  const sourceCard = allCards.find((c) => c.luhmannId === sourceId);
  if (!sourceCard) throw new Error(`Card ${sourceId} not found`);
  if (newParentId !== null) {
    const parent = allCards.find((c) => c.luhmannId === newParentId);
    if (!parent) throw new Error(`Parent ${newParentId} not found`);
  }

  // 1. 收集 source + Folgezettel 后代
  const beingRenamed = new Set<string>([sourceId]);
  const queue = [sourceId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of allCards) {
      if (isDirectChild(c.luhmannId, cur) && !beingRenamed.has(c.luhmannId)) {
        beingRenamed.add(c.luhmannId);
        queue.push(c.luhmannId);
      }
    }
  }

  // 2. 防环：目标不能在 source 子树里
  if (newParentId !== null && beingRenamed.has(newParentId)) {
    throw new Error('Cannot reparent into own descendant');
  }

  // 3. 已经是 child of newParent → no-op
  const currentParent = deriveParentIdFn(sourceId);
  if (currentParent === newParentId) {
    return { renames: new Map() };
  }

  // 4. 算 rename map
  const allIds = new Set(allCards.map((c) => c.luhmannId));
  const remaining = new Set(allIds);
  for (const id of beingRenamed) remaining.delete(id);
  const claimed = new Set<string>();
  const renames = new Map<string, string>();

  function nextAvailable(parentNewId: string): string {
    if (parentNewId === '') {
      // 顶层：默认数字
      for (let n = 1; n < 100000; n++) {
        const c = String(n);
        if (!remaining.has(c) && !claimed.has(c)) return c;
      }
      throw new Error('out of top-level digit ids');
    }
    const lastChar = parentNewId.at(-1)!;
    const nextIsDigit = !/\d/.test(lastChar);
    if (nextIsDigit) {
      for (let i = 1; i < 100000; i++) {
        const c = parentNewId + i;
        if (!remaining.has(c) && !claimed.has(c)) return c;
      }
    } else {
      for (let i = 0; i < 26; i++) {
        const c = parentNewId + String.fromCharCode(97 + i);
        if (!remaining.has(c) && !claimed.has(c)) return c;
      }
      // 字母用完 → aa, ab, ... (Excel 列风格，不严格 Folgezettel 但兜底)
      for (let i = 0; i < 26 * 26; i++) {
        const a = String.fromCharCode(97 + Math.floor(i / 26));
        const b = String.fromCharCode(97 + (i % 26));
        const c = parentNewId + a + b;
        if (!remaining.has(c) && !claimed.has(c)) return c;
      }
    }
    throw new Error('out of suffixes under ' + parentNewId);
  }

  function recurse(oldId: string, parentNewId: string): void {
    const newId = nextAvailable(parentNewId);
    renames.set(oldId, newId);
    claimed.add(newId);
    // 找 oldId 的直接 Folgezettel 子
    const children: string[] = [];
    for (const c of allCards) {
      if (isDirectChild(c.luhmannId, oldId)) children.push(c.luhmannId);
    }
    children.sort();
    for (const child of children) recurse(child, newId);
  }

  recurse(sourceId, newParentId ?? '');
  return { renames };
}

export async function reparentCard(
  db: Database.Database,
  repo: CardRepository,
  sourceId: string,
  newParentIdRaw: string | null,
): Promise<ReparentResult> {
  const sourceCanon = canonicalize(sourceId);
  const newParentCanon = newParentIdRaw === null ? null : canonicalize(newParentIdRaw);

  const { renames } = planReparent(repo, sourceCanon, newParentCanon);
  if (renames.size === 0) {
    return { renames: {}, filesUpdated: 0, workspacesUpdated: 0 };
  }

  // 1. Rename phase — 两步走避免中间路径冲突
  const TMP_PREFIX = `__reparent_tmp_${Date.now()}_`;
  const fileMoves: Array<{ from: string; tmp: string; to: string }> = [];
  for (const [oldId] of renames) {
    const card = repo.getById(oldId);
    if (!card) continue;
    const dir = dirname(card.filePath);
    const tmp = join(dir, `${TMP_PREFIX}${oldId}.md`);
    const newId = renames.get(oldId)!;
    const to = join(dir, `${newId}.md`);
    fileMoves.push({ from: card.filePath, tmp, to });
  }
  // step 1: 全部 → tmp
  for (const m of fileMoves) await rename(m.from, m.tmp);
  // step 2: tmp → 新名
  for (const m of fileMoves) await rename(m.tmp, m.to);

  // 2. Rewrite structural metadata and explicit wikilinks throughout vault.
  // Do not run broad raw-text replacements: plain title/body mentions such as
  // "1a is an example" are user prose, not card identity metadata.
  let filesUpdated = 0;
  for await (const file of walkMd(config.vaultPath)) {
    const raw = await readFile(file, 'utf8');
    const parsed = matter(raw, {});
    let changed = false;
    let body = parsed.content;
    for (const [oldId, newId] of renames) {
      // [[oldId]] 或 [[oldId|alias]] —— 别名保留
      const wikiRe = new RegExp(`\\[\\[\\s*${escapeForRegex(oldId)}\\s*(\\|[^\\]]+)?\\s*\\]\\]`, 'g');
      const nextBody = body.replace(wikiRe, (_m, alias?: string) => `[[${newId}${alias ?? ''}]]`);
      if (nextBody !== body) {
        body = nextBody;
        changed = true;
      }

      if (String(parsed.data.luhmannId ?? '') === oldId) {
        parsed.data.luhmannId = newId;
        changed = true;
      }
      if (String(parsed.data.id ?? '') === oldId) {
        parsed.data.id = newId;
        changed = true;
      }
      if (Array.isArray(parsed.data.crossLinks)) {
        const next = parsed.data.crossLinks.map((x: unknown) =>
          String(x).trim() === oldId ? newId : x,
        );
        if (JSON.stringify(next) !== JSON.stringify(parsed.data.crossLinks)) {
          parsed.data.crossLinks = next;
          changed = true;
        }
      }
    }
    if (changed) {
      await writeFile(file, matter.stringify(body, parsed.data), 'utf8');
      filesUpdated++;
    }
  }

  // 3. 更新 SQLite —— 删旧记录（按 oldId），重新解析新文件
  for (const oldId of renames.keys()) {
    db.prepare(`DELETE FROM cards WHERE luhmann_id = ?`).run(oldId);
  }
  // 重新解析所有新文件（也会处理别人引用 oldId 的卡，因为它们的 crossLinks 已被改写）
  for await (const file of walkMd(config.vaultPath)) {
    const card = await parseCardFile(file);
    if (card) repo.upsertOne(card);
  }

  // 4. 副作用：positions / starred / workspaces 里的旧 id 改成新 id
  for (const [oldId, newId] of renames) {
    await renameCardInAllScopes(oldId, newId);
    await renameStarred(oldId, newId);
  }
  const { renameCardRefsInWorkspaces } = await import('./workspaces.js');
  const workspacesUpdated = await renameCardRefsInWorkspaces(renames);

  return { renames: Object.fromEntries(renames), filesUpdated, workspacesUpdated };
}
