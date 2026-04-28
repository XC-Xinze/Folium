import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import { config } from '../config.js';
import { CardRepository } from '../vault/repository.js';
import { walkMd } from '../vault/scanner.js';
import { loadAll as loadAllPositions } from './positions.js';
import { mkdir, writeFile as fsWrite } from 'node:fs/promises';
import { join } from 'node:path';

interface DeleteResult {
  deleted: string;
  filesUpdated: number;
  workspacesUpdated: number;
}

/**
 * 删除一张卡片：
 *   1. 删 .md 文件
 *   2. 其他文件 frontmatter.crossLinks 移除此 id
 *   3. 所有 scope 的 positions 移除此 id
 *   4. 所有 workspace 中引用此 cardId 的 card 节点和涉及的 edges 移除
 *   5. SQLite 删该行
 *
 *   注意：正文里的 [[id]] 文本保留（变成"断链"），不强制改用户的写作内容。
 */
export async function deleteVaultCard(
  db: Database.Database,
  repo: CardRepository,
  cardId: string,
): Promise<DeleteResult> {
  const card = repo.getById(cardId);
  if (!card) throw new Error(`card not found: ${cardId}`);

  // 1. 把 .md 移到 .zettel/trash/，可恢复（不直接 unlink）
  //    命名带时间戳避免重名：trash/20260424T0930-{id}.md
  const trashDir = join(config.vaultPath, '.zettel', 'trash');
  await mkdir(trashDir, { recursive: true });
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .slice(0, 15); // 20260424T093030
  const trashPath = join(trashDir, `${ts}-${cardId}.md`);
  try {
    await rename(card.filePath, trashPath);
  } catch (err) {
    throw new Error(`无法移到回收站: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. 清理其他文件的 frontmatter.crossLinks
  let filesUpdated = 0;
  for await (const file of walkMd(config.vaultPath)) {
    if (basename(file, '.md') === cardId) continue;
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = matter(raw, {});
    if (Array.isArray(parsed.data.crossLinks)) {
      const before = parsed.data.crossLinks.length;
      parsed.data.crossLinks = parsed.data.crossLinks.filter(
        (x: unknown) => String(x) !== cardId,
      );
      if (parsed.data.crossLinks.length !== before) {
        await writeFile(file, matter.stringify(parsed.content, parsed.data), 'utf8');
        filesUpdated += 1;
      }
    }
  }

  // 3. 清理 positions（所有 scope）
  const positions = await loadAllPositions();
  let positionsChanged = false;
  for (const scope of Object.keys(positions)) {
    if (positions[scope]?.[cardId]) {
      delete positions[scope][cardId];
      positionsChanged = true;
    }
  }
  if (positionsChanged) {
    const ZETTEL_DIR = '.zettel';
    const POSITIONS_FILE = 'positions.json';
    const dir = join(config.vaultPath, ZETTEL_DIR);
    await mkdir(dir, { recursive: true });
    await fsWrite(join(dir, POSITIONS_FILE), JSON.stringify(positions, null, 2), 'utf8');
  }

  // 4. 清理 workspaces：移除引用此 cardId 的 card 节点 + 相关 edges
  const { loadAll: loadAllWs, updateWorkspace } = await import('./workspaces.js');
  const workspaces: Record<string, import('./workspaces.js').Workspace> = await loadAllWs();
  let workspacesUpdated = 0;
  for (const ws of Object.values(workspaces)) {
    const refNodeIds = ws.nodes
      .filter((n) => n.kind === 'card' && (n as { cardId: string }).cardId === cardId)
      .map((n) => n.id);
    if (refNodeIds.length === 0) continue;
    const newNodes = ws.nodes.filter((n) => !refNodeIds.includes(n.id));
    const newEdges = ws.edges.filter(
      (e: { source: string; target: string }) =>
        !refNodeIds.includes(e.source) && !refNodeIds.includes(e.target),
    );
    await updateWorkspace(ws.id, { nodes: newNodes, edges: newEdges });
    workspacesUpdated += 1;
  }

  // 5. SQLite 删行
  db.prepare(`DELETE FROM cards WHERE luhmann_id = ?`).run(cardId);

  return { deleted: cardId, filesUpdated, workspacesUpdated };
}
