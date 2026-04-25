import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import matter from 'gray-matter';
import { config } from '../config.js';

/**
 * 工作区 = 用户自己拼起来的一块画布。
 *   - 可以把任意 vault 卡片拽进来（card 节点：仅引用，不复制）
 *   - 可以加临时卡片（temp 节点：暂存在 workspace，可"提升"为 vault 真实卡）
 *   - 可以加自由便签（note 节点：纯 markdown）
 *   - 节点间可以画连线（edge）；连线可"应用"为原卡片的 [[link]]
 *   - 多个工作区互相独立
 *
 * 存储：<vault>/.zettel/workspaces.json
 *   { [id: string]: Workspace }
 */

export interface CardRefNode {
  kind: 'card';
  id: string; // workspace-local uuid
  cardId: string; // vault 中的 luhmannId
  x: number;
  y: number;
}

export interface TempCardNode {
  kind: 'temp';
  id: string;
  title: string;
  content: string; // markdown
  x: number;
  y: number;
}

export interface NoteNode {
  kind: 'note';
  id: string;
  content: string; // markdown
  x: number;
  y: number;
}

export type WorkspaceNode = CardRefNode | TempCardNode | NoteNode;

export interface WorkspaceEdge {
  id: string;
  source: string; // workspace-local node id
  target: string;
  /** 端点 handle id（如 'top', 'bottom', 'left-out'）— 不指定时 React Flow 渲染会含糊 */
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  /** 是否已写回 vault 形成真正的 [[link]] */
  applied?: boolean;
  /** 应用时写到了哪张卡的 .md（保留以便撤销） */
  appliedToFile?: string;
  /** 应用时插入的 marker 字符串（HTML 注释 + 占位文本），撤销时按此精确定位 */
  appliedMarker?: string;
  /** 等待 promote 的 temp 节点 id 列表（target 是 temp 时填入） */
  pendingTempIds?: string[];
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
}

const ZETTEL_DIR = '.zettel';
const FILE = 'workspaces.json';

const dirPath = () => join(config.vaultPath, ZETTEL_DIR);
const filePath = () => join(dirPath(), FILE);

let cache: Record<string, Workspace> | null = null;

export async function loadAll(): Promise<Record<string, Workspace>> {
  if (cache) return cache;
  try {
    const raw = await readFile(filePath(), 'utf8');
    cache = JSON.parse(raw) as Record<string, Workspace>;
    return cache;
  } catch {
    cache = {};
    return cache;
  }
}

async function flush(map: Record<string, Workspace>): Promise<void> {
  await mkdir(dirPath(), { recursive: true });
  await writeFile(filePath(), JSON.stringify(map, null, 2), 'utf8');
  cache = map;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const map = await loadAll();
  return Object.values(map).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const map = await loadAll();
  return map[id] ?? null;
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const map = await loadAll();
  const now = new Date().toISOString();
  const ws: Workspace = {
    id: randomUUID(),
    name: name || '新工作区',
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
  };
  map[ws.id] = ws;
  await flush(map);
  return ws;
}

export async function updateWorkspace(
  id: string,
  patch: Partial<Pick<Workspace, 'name' | 'nodes' | 'edges'>>,
): Promise<Workspace> {
  const map = await loadAll();
  const cur = map[id];
  if (!cur) throw new Error('workspace not found');
  // 不能用 {...cur, ...patch}：patch 里 undefined 会覆盖 cur 的有效值
  const next: Workspace = { ...cur, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.nodes !== undefined) next.nodes = patch.nodes;
  if (patch.edges !== undefined) next.edges = patch.edges;
  map[id] = next;
  await flush(map);
  return next;
}

/** 软删 —— 删的 workspace 完整 JSON 推到内存 trash 里给 undo 用 */
const wsTrash: Array<{ ts: number; ws: Workspace }> = [];
const WS_TRASH_MAX = 50;

export async function deleteWorkspace(id: string): Promise<void> {
  const map = await loadAll();
  const ws = map[id];
  delete map[id];
  await flush(map);
  if (ws) {
    wsTrash.push({ ts: Date.now(), ws });
    if (wsTrash.length > WS_TRASH_MAX) wsTrash.shift();
  }
}

/** 恢复某个被软删的 workspace（按 id） */
export async function restoreWorkspace(id: string): Promise<Workspace | null> {
  const idx = wsTrash.findIndex((e) => e.ws.id === id);
  if (idx < 0) return null;
  const removed = wsTrash.splice(idx, 1)[0];
  if (!removed) return null;
  const ws = removed.ws;
  const map = await loadAll();
  map[ws.id] = ws;
  await flush(map);
  return ws;
}

export function listDeletedWorkspaces(): Array<{ ts: number; ws: Workspace }> {
  return [...wsTrash].sort((a, b) => b.ts - a.ts);
}

/**
 * Delete a workspace edge. If it was applied (i.e. wrote a [[link]] into a vault
 * .md file), unapply first to clean up the source card before removing the edge.
 */
export async function deleteEdge(
  repo: CardRepository,
  workspaceId: string,
  edgeId: string,
): Promise<{ ok: true } | { error: string }> {
  const ws = await getWorkspace(workspaceId);
  if (!ws) return { error: 'workspace not found' };
  const edge = ws.edges.find((e) => e.id === edgeId);
  if (!edge) return { error: 'edge not found' };
  if (edge.applied) {
    const unres = await unapplyEdge(repo, workspaceId, edgeId);
    if ('error' in unres) return unres;
  }
  // Re-load (unapply may have mutated state)
  const fresh = await getWorkspace(workspaceId);
  if (!fresh) return { error: 'workspace not found' };
  const remaining = fresh.edges.filter((e) => e.id !== edgeId);
  await updateWorkspace(workspaceId, { edges: remaining });
  return { ok: true };
}

/* ============================================================
 * Workspace-link discovery (for vault canvas overlay)
 * ============================================================ */

export interface WorkspaceLinkEndpoint {
  kind: 'card' | 'temp';
  /** When kind='card': vault luhmannId. When kind='temp': workspace-local node id. */
  id: string;
  /** Temp-only fields */
  title?: string;
  content?: string;
}

export interface WorkspaceLink {
  workspaceId: string;
  workspaceName: string;
  edgeId: string;
  source: WorkspaceLinkEndpoint;
  target: WorkspaceLinkEndpoint;
}

/**
 * Find all workspace edges that touch any of the given vault cards (by luhmannId).
 * Used by the vault canvas to overlay workspace-derived links/temps as "potential"-style nodes.
 *
 * Excludes:
 *   - edges involving notes
 *   - temp ↔ temp edges (those stay workspace-only per the user's spec)
 */
export async function listWorkspaceLinksFor(cardIds: string[]): Promise<WorkspaceLink[]> {
  const all = await loadAll();
  const cardSet = new Set(cardIds);
  const result: WorkspaceLink[] = [];
  for (const ws of Object.values(all)) {
    const nodeById = new Map(ws.nodes.map((n) => [n.id, n] as const));
    for (const edge of ws.edges) {
      const src = nodeById.get(edge.source);
      const tgt = nodeById.get(edge.target);
      if (!src || !tgt) continue;
      if (src.kind === 'note' || tgt.kind === 'note') continue;
      if (src.kind === 'temp' && tgt.kind === 'temp') continue;

      const srcIsRelevantCard = src.kind === 'card' && cardSet.has((src as CardRefNode).cardId);
      const tgtIsRelevantCard = tgt.kind === 'card' && cardSet.has((tgt as CardRefNode).cardId);
      if (!srcIsRelevantCard && !tgtIsRelevantCard) continue;

      const toEndpoint = (n: WorkspaceNode): WorkspaceLinkEndpoint =>
        n.kind === 'card'
          ? { kind: 'card', id: (n as CardRefNode).cardId }
          : {
              kind: 'temp',
              id: n.id,
              title: (n as TempCardNode).title,
              content: (n as TempCardNode).content,
            };

      result.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        edgeId: edge.id,
        source: toEndpoint(src),
        target: toEndpoint(tgt),
      });
    }
  }
  return result;
}

/* ============================================================
 * Apply / Unapply edge to vault
 * ============================================================ */

import { CardRepository } from '../vault/repository.js';
import { parseCardFile } from '../vault/parser.js';

/**
 * Re-parse and upsert a card right after we wrote its .md file.
 * The chokidar watcher debounces ~200ms before re-indexing, but the frontend
 * refetches immediately on apply success — so we need to refresh the in-memory
 * repo synchronously, otherwise the next `getCard` returns stale data.
 */
async function reindexFile(repo: CardRepository, filePath: string): Promise<void> {
  try {
    const card = await parseCardFile(filePath);
    if (card) repo.upsertOne(card);
  } catch (err) {
    console.error('[applyEdge] reindex failed', filePath, err);
  }
}

/**
 * Apply commits a workspace edge into the vault as a real [[link]].
 *
 * Only meaningful for card↔card edges (both endpoints are real vault cards).
 * Edges involving a temp card or a note can't be committed by the user — they're
 * workspace-only sketches. When a temp card is promoted to a real vault card via
 * tempToVault, every workspace edge involving it is auto-materialized at that
 * moment (no manual Apply needed).
 */
export async function applyEdge(
  repo: CardRepository,
  workspaceId: string,
  edgeId: string,
): Promise<{ ok: true } | { error: string }> {
  const ws = await getWorkspace(workspaceId);
  if (!ws) return { error: 'workspace not found' };
  const edge = ws.edges.find((e) => e.id === edgeId);
  if (!edge) return { error: 'edge not found' };

  const source = ws.nodes.find((n) => n.id === edge.source);
  const target = ws.nodes.find((n) => n.id === edge.target);
  if (!source || !target) return { error: 'edge endpoints not found' };
  if (source.kind !== 'card' || target.kind !== 'card') {
    return {
      error:
        'Apply only commits links between two real vault cards. Edges involving a temp card or a note will materialize automatically when the temp is promoted.',
    };
  }
  if (edge.applied) return { error: 'This edge has already been applied' };

  const sourceCard = repo.getById((source as CardRefNode).cardId);
  if (!sourceCard) return { error: 'source card not found in vault' };
  const targetCard = repo.getById((target as CardRefNode).cardId);
  if (!targetCard) return { error: 'target card not found in vault' };
  const marker = `<!-- ws:${workspaceId}:${edgeId} --> [[${targetCard.luhmannId}]]`;

  const raw = await readFile(sourceCard.filePath, 'utf8');
  const parsed = matter(raw);
  const body = parsed.content.endsWith('\n')
    ? parsed.content + marker + '\n'
    : parsed.content + '\n\n' + marker + '\n';
  if (!Array.isArray(parsed.data.crossLinks)) parsed.data.crossLinks = [];
  if (!parsed.data.crossLinks.includes(targetCard.luhmannId)) {
    parsed.data.crossLinks.push(targetCard.luhmannId);
  }
  await writeFile(sourceCard.filePath, matter.stringify(body, parsed.data), 'utf8');
  await reindexFile(repo, sourceCard.filePath);

  edge.applied = true;
  edge.appliedToFile = sourceCard.filePath;
  edge.appliedMarker = marker;

  await updateWorkspace(workspaceId, { edges: ws.edges });
  return { ok: true };
}

export async function unapplyEdge(
  repo: CardRepository,
  workspaceId: string,
  edgeId: string,
): Promise<{ ok: true } | { error: string }> {
  const ws = await getWorkspace(workspaceId);
  if (!ws) return { error: 'workspace not found' };
  const edge = ws.edges.find((e) => e.id === edgeId);
  if (!edge) return { error: 'edge not found' };
  if (!edge.applied) {
    return { error: 'This edge has not been applied' };
  }

  // If a vault file was written (real-card target), undo it.
  // Deferred temp-target applies didn't touch the vault, so nothing to do there.
  if (edge.appliedToFile) {
    const raw = await readFile(edge.appliedToFile, 'utf8');
    const parsed = matter(raw);
    // Match by the stable `<!-- ws:wsId:edgeId` prefix (regardless of marker tail)
    const stableMarker = `<!-- ws:${workspaceId}:${edgeId}`;
    const lines = parsed.content.split('\n');
    const newLines = lines.filter((line) => !line.includes(stableMarker));
    const newBody = newLines.join('\n');

    // Drop the target id from frontmatter.crossLinks if no other [[link]] references it
    const target = ws.nodes.find((n) => n.id === edge.target);
    if (target && target.kind === 'card') {
      const targetCardId = (target as CardRefNode).cardId;
      const escaped = targetCardId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stillReferenced = new RegExp(
        `\\[\\[\\s*${escaped}\\s*(\\|[^\\]]+)?\\s*\\]\\]`,
      ).test(newBody);
      if (!stillReferenced && Array.isArray(parsed.data.crossLinks)) {
        parsed.data.crossLinks = parsed.data.crossLinks.filter(
          (x: unknown) => String(x) !== targetCardId,
        );
      }
    }
    await writeFile(edge.appliedToFile, matter.stringify(newBody, parsed.data), 'utf8');
    await reindexFile(repo, edge.appliedToFile);
  }

  edge.applied = false;
  delete edge.appliedToFile;
  delete edge.appliedMarker;
  delete edge.pendingTempIds;
  await updateWorkspace(workspaceId, { edges: ws.edges });
  return { ok: true };
}

/**
 * List every workspace edge that touches a given workspace node id.
 * Used by tempToVault to auto-materialize all edges involving a temp that's
 * being promoted (not just edges previously marked as applied).
 */
async function findEdgesTouching(nodeId: string): Promise<Array<{ ws: Workspace; edge: WorkspaceEdge }>> {
  const all = await loadAll();
  const result: Array<{ ws: Workspace; edge: WorkspaceEdge }> = [];
  for (const ws of Object.values(all)) {
    for (const e of ws.edges) {
      if (e.source === nodeId || e.target === nodeId) {
        result.push({ ws, edge: e });
      }
    }
  }
  return result;
}

/**
 * Promote a temp card to a real vault card:
 *   1. Validate the luhmannId is free
 *   2. Write the .md file
 *   3. Replace the temp workspace node with a card-ref to the new vault card
 *   4. Auto-materialize every workspace edge that touches this node and whose
 *      other end is also a real vault card. The user's drawn direction is
 *      preserved (source.md gets `[[target]]`).
 *   5. Edges to other still-temp nodes are left in place — they'll materialize
 *      when those temps are promoted later.
 */
export async function tempToVault(
  repo: CardRepository,
  workspaceId: string,
  nodeId: string,
  luhmannId: string,
): Promise<{ ok: true; luhmannId: string } | { error: string }> {
  const ws = await getWorkspace(workspaceId);
  if (!ws) return { error: 'workspace not found' };
  const node = ws.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== 'temp') return { error: 'not a temp card' };

  const tempNode = node as TempCardNode;

  // Create the vault card via the writer
  const { writeNewCard } = await import('../vault/writer.js');
  let createdFile: string;
  try {
    const result = await writeNewCard({
      luhmannId,
      title: tempNode.title,
      content: tempNode.content,
      status: 'ATOMIC',
    });
    createdFile = result.filePath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
  await reindexFile(repo, createdFile);

  // Replace node: temp → card ref
  const idx = ws.nodes.findIndex((n) => n.id === nodeId);
  ws.nodes[idx] = {
    kind: 'card',
    id: tempNode.id,
    cardId: luhmannId,
    x: tempNode.x,
    y: tempNode.y,
  };
  await updateWorkspace(workspaceId, { nodes: ws.nodes });

  // Auto-materialize every workspace edge touching this temp where the other
  // end is a real vault card. Note: ws.nodes for *this* workspace was already
  // mutated above (temp → card), so the lookup below sees both ends as cards.
  const touching = await findEdgesTouching(tempNode.id);
  for (const { ws: pws, edge } of touching) {
    try {
      // Re-find the nodes with the freshest workspace data (might be `ws` itself)
      const wsNow = pws.id === workspaceId ? ws : pws;
      const sourceNode = wsNow.nodes.find((n) => n.id === edge.source);
      const targetNode = wsNow.nodes.find((n) => n.id === edge.target);
      if (!sourceNode || !targetNode) continue;
      // Skip if either end is still a temp/note (will resolve on later promotion)
      if (sourceNode.kind !== 'card' || targetNode.kind !== 'card') continue;

      const sourceCardId = (sourceNode as CardRefNode).cardId;
      const targetCardId = (targetNode as CardRefNode).cardId;
      const sourceCard = repo.getById(sourceCardId);
      if (!sourceCard) continue;

      // Old-style edges from a previous refactor may already have a placeholder
      // marker in source.md — replace it. Otherwise append a fresh marker.
      const stableMarker = `<!-- ws:${wsNow.id}:${edge.id}`;
      const newMarker = `<!-- ws:${wsNow.id}:${edge.id} --> [[${targetCardId}]]`;
      const raw = await readFile(sourceCard.filePath, 'utf8');
      const parsed = matter(raw);
      const hasOldMarker = parsed.content.split('\n').some((l) => l.includes(stableMarker));
      let newBody: string;
      if (hasOldMarker) {
        newBody = parsed.content
          .split('\n')
          .map((l) => (l.includes(stableMarker) ? newMarker : l))
          .join('\n');
      } else {
        newBody = parsed.content.endsWith('\n')
          ? parsed.content + newMarker + '\n'
          : parsed.content + '\n\n' + newMarker + '\n';
      }
      if (!Array.isArray(parsed.data.crossLinks)) parsed.data.crossLinks = [];
      if (!parsed.data.crossLinks.includes(targetCardId)) {
        parsed.data.crossLinks.push(targetCardId);
      }
      await writeFile(sourceCard.filePath, matter.stringify(newBody, parsed.data), 'utf8');
      await reindexFile(repo, sourceCard.filePath);

      edge.applied = true;
      edge.appliedToFile = sourceCard.filePath;
      edge.appliedMarker = newMarker;
      delete edge.pendingTempIds;
      await updateWorkspace(wsNow.id, { edges: wsNow.edges });
    } catch (err) {
      console.error('failed to materialize edge', edge.id, err);
    }
  }

  return { ok: true, luhmannId };
}
