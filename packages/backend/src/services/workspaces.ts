import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
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
  color?: string;
  note?: string;
  /** Workspace-only label position along the edge, 0..1. */
  labelT?: number;
  /** Workspace-only label offset perpendicular to the edge, in flow px. */
  labelOffset?: number;
  /** 是否已写回 vault 形成真正的 [[link]] */
  applied?: boolean;
  /** Mirrors an existing vault [[link]]; not owned by this workspace edge. */
  vaultLink?: boolean;
  /** Mirrors vault structure such as Folgezettel parent-child; not applyable. */
  vaultStructure?: boolean;
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

function normalizeEdge(edge: WorkspaceEdge): WorkspaceEdge {
  return {
    ...edge,
    applied: !!edge.applied,
    vaultLink: !!edge.vaultLink,
    vaultStructure: !!edge.vaultStructure || edge.label === 'tree',
  };
}

function normalizeWorkspace(ws: Workspace): Workspace {
  return {
    ...ws,
    nodes: Array.isArray(ws.nodes) ? ws.nodes : [],
    edges: Array.isArray(ws.edges) ? ws.edges.map(normalizeEdge) : [],
  };
}

export async function loadAll(): Promise<Record<string, Workspace>> {
  if (cache) return cache;
  try {
    const raw = await readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, Workspace>;
    cache = Object.fromEntries(
      Object.entries(parsed).map(([id, ws]) => [id, normalizeWorkspace(ws)]),
    );
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
  if (patch.edges !== undefined) next.edges = patch.edges.map(normalizeEdge);
  map[id] = next;
  await flush(map);
  return next;
}

export async function renameCardRefsInWorkspaces(renames: Map<string, string>): Promise<number> {
  if (renames.size === 0) return 0;
  const map = await loadAll();
  let changed = 0;
  const now = new Date().toISOString();

  for (const ws of Object.values(map)) {
    let touched = false;
    const nodes = ws.nodes.map((node) => {
      if (node.kind !== 'card') return node;
      const nextCardId = renames.get(node.cardId);
      if (!nextCardId) return node;
      touched = true;
      return { ...node, cardId: nextCardId };
    });
    if (!touched) continue;
    ws.nodes = nodes;
    ws.updatedAt = now;
    changed += 1;
  }

  if (changed > 0) {
    await flush(map);
    await repairWorkspaces();
  }
  return changed;
}

export interface WorkspaceRepairReport {
  workspacesScanned: number;
  nodesRemoved: number;
  edgesRemoved: number;
  edgesNormalized: number;
  duplicatesMerged: number;
}

export async function repairWorkspaces(): Promise<WorkspaceRepairReport> {
  const map = await loadAll();
  const report: WorkspaceRepairReport = {
    workspacesScanned: 0,
    nodesRemoved: 0,
    edgesRemoved: 0,
    edgesNormalized: 0,
    duplicatesMerged: 0,
  };

  for (const ws of Object.values(map)) {
    report.workspacesScanned += 1;
    const originalEdgesJson = JSON.stringify(ws.edges);
    const cardNodeByCardId = new Map<string, string>();
    const nodeIdRemap = new Map<string, string>();
    const nextNodes: WorkspaceNode[] = [];

    for (const node of ws.nodes) {
      if (node.kind === 'card') {
        const existingId = cardNodeByCardId.get(node.cardId);
        if (existingId) {
          nodeIdRemap.set(node.id, existingId);
          report.nodesRemoved += 1;
          report.duplicatesMerged += 1;
          continue;
        }
        cardNodeByCardId.set(node.cardId, node.id);
      }
      nextNodes.push(node);
    }

    const liveNodeIds = new Set(nextNodes.map((node) => node.id));
    const seenEdges = new Set<string>();
    const nextEdges: WorkspaceEdge[] = [];
    for (const rawEdge of ws.edges) {
      const edge = normalizeEdge({
        ...rawEdge,
        source: nodeIdRemap.get(rawEdge.source) ?? rawEdge.source,
        target: nodeIdRemap.get(rawEdge.target) ?? rawEdge.target,
      });
      if (!liveNodeIds.has(edge.source) || !liveNodeIds.has(edge.target) || edge.source === edge.target) {
        report.edgesRemoved += 1;
        continue;
      }
      const key = [
        edge.source,
        edge.target,
        edge.sourceHandle ?? '',
        edge.targetHandle ?? '',
        edge.label ?? '',
      ].join('\u0000');
      if (seenEdges.has(key)) {
        report.edgesRemoved += 1;
        report.duplicatesMerged += 1;
        continue;
      }
      seenEdges.add(key);
      nextEdges.push(edge);
    }

    if (originalEdgesJson !== JSON.stringify(nextEdges)) report.edgesNormalized += 1;
    ws.nodes = nextNodes;
    ws.edges = nextEdges;
    ws.updatedAt = new Date().toISOString();
  }

  await flush(map);
  return report;
}

/* ============================================================
 * 软删 —— 全部落盘到 .zettel/ws-trash/ 和 .zettel/temp-trash/
 * 重启不丢；可以从 TrashPanel 还原。
 * 文件名 timestamp + uuid，metadata 全在 JSON 里。
 * ============================================================ */
const WS_TRASH_DIR = () => join(config.vaultPath, ZETTEL_DIR, 'ws-trash');
const TEMP_TRASH_DIR = () => join(config.vaultPath, ZETTEL_DIR, 'temp-trash');

function trashFilename(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  return `${ts}-${randomUUID()}.json`;
}

export async function deleteWorkspace(id: string): Promise<void> {
  const map = await loadAll();
  const ws = map[id];
  delete map[id];
  await flush(map);
  if (ws) {
    await mkdir(WS_TRASH_DIR(), { recursive: true });
    const fp = join(WS_TRASH_DIR(), trashFilename());
    await writeFile(fp, JSON.stringify(ws, null, 2), 'utf8');
  }
}

/** 恢复某个被软删的 workspace（按 trashFileName 还原 + 删 trash 文件） */
export async function restoreWorkspaceFromTrash(trashFileName: string): Promise<Workspace | null> {
  const fp = join(WS_TRASH_DIR(), trashFileName);
  let raw: string;
  try {
    raw = await readFile(fp, 'utf8');
  } catch {
    return null;
  }
  const ws = JSON.parse(raw) as Workspace;
  const map = await loadAll();
  // id 冲突 → 新生成 id 避免覆盖（保守做法，不动现有的）
  if (map[ws.id]) ws.id = randomUUID();
  map[ws.id] = ws;
  await flush(map);
  await unlink(fp).catch(() => undefined);
  return ws;
}

/** 兼容旧 undo 路径（按原 ws.id 找）—— 主要给 ⌘Z 用 */
export async function restoreWorkspace(id: string): Promise<Workspace | null> {
  const list = await listDeletedWorkspaces();
  const entry = list.find((e) => e.workspace.id === id);
  if (!entry) return null;
  return restoreWorkspaceFromTrash(entry.fileName);
}

export interface WorkspaceTrashEntry {
  fileName: string;
  workspace: Workspace;
  deletedAt: string;
}

export async function listDeletedWorkspaces(): Promise<WorkspaceTrashEntry[]> {
  const dir = WS_TRASH_DIR();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: WorkspaceTrashEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, f), 'utf8');
      const ws = JSON.parse(raw) as Workspace;
      const tsMatch = f.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
      const deletedAt = tsMatch
        ? `${tsMatch[1]}-${tsMatch[2]}-${tsMatch[3]}T${tsMatch[4]}:${tsMatch[5]}:${tsMatch[6]}Z`
        : new Date().toISOString();
      out.push({ fileName: f, workspace: ws, deletedAt });
    } catch {}
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export async function purgeDeletedWorkspace(fileName: string): Promise<void> {
  await unlink(join(WS_TRASH_DIR(), fileName)).catch(() => undefined);
}

/* ---- temp 卡 trash ---- */

export interface TempTrashEntry {
  fileName: string;
  workspaceId: string;
  workspaceName: string;
  /** node 完整 JSON */
  node: TempCardNode;
  deletedAt: string;
}

/** 软删 temp 卡：保存到 temp-trash/，给 TrashPanel 还原 */
export async function trashTempNode(
  workspaceId: string,
  workspaceName: string,
  node: TempCardNode,
): Promise<void> {
  await mkdir(TEMP_TRASH_DIR(), { recursive: true });
  const fp = join(TEMP_TRASH_DIR(), trashFilename());
  await writeFile(
    fp,
    JSON.stringify({ workspaceId, workspaceName, node }, null, 2),
    'utf8',
  );
}

export async function listDeletedTempNodes(): Promise<TempTrashEntry[]> {
  const dir = TEMP_TRASH_DIR();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: TempTrashEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, f), 'utf8');
      const data = JSON.parse(raw) as {
        workspaceId: string;
        workspaceName: string;
        node: TempCardNode;
      };
      const tsMatch = f.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
      const deletedAt = tsMatch
        ? `${tsMatch[1]}-${tsMatch[2]}-${tsMatch[3]}T${tsMatch[4]}:${tsMatch[5]}:${tsMatch[6]}Z`
        : new Date().toISOString();
      out.push({
        fileName: f,
        workspaceId: data.workspaceId,
        workspaceName: data.workspaceName,
        node: data.node,
        deletedAt,
      });
    } catch {}
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** 还原 temp 卡到原 workspace（如果原 workspace 没了就报错让用户自己恢复 ws） */
export async function restoreTempNode(fileName: string): Promise<{
  ok: true;
  workspaceId: string;
} | { error: string }> {
  const fp = join(TEMP_TRASH_DIR(), fileName);
  let raw: string;
  try {
    raw = await readFile(fp, 'utf8');
  } catch {
    return { error: 'trash file not found' };
  }
  const data = JSON.parse(raw) as {
    workspaceId: string;
    workspaceName: string;
    node: TempCardNode;
  };
  const map = await loadAll();
  const ws = map[data.workspaceId];
  if (!ws) {
    return { error: `Workspace "${data.workspaceName}" no longer exists. Restore the workspace first.` };
  }
  // node id 冲突 → 给新 id
  let nodeId = data.node.id;
  if (ws.nodes.some((n) => n.id === nodeId)) nodeId = randomUUID();
  ws.nodes.push({ ...data.node, id: nodeId });
  await flush(map);
  await unlink(fp).catch(() => undefined);
  return { ok: true, workspaceId: data.workspaceId };
}

export async function purgeDeletedTempNode(fileName: string): Promise<void> {
  await unlink(join(TEMP_TRASH_DIR(), fileName)).catch(() => undefined);
}

/** vault 切换时调，清空 in-memory cache 让下次 loadAll 从新 vault 的 .zettel/ 读 */
export function resetWorkspacesCache(): void {
  cache = null;
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
  if (edge.vaultLink || edge.vaultStructure || edge.label === 'tree') {
    return { error: 'This edge already exists in the vault' };
  }
  if (edge.applied) return { error: 'This edge has already been applied' };

  const sourceCard = repo.getById((source as CardRefNode).cardId);
  if (!sourceCard) return { error: 'source card not found in vault' };
  const targetCard = repo.getById((target as CardRefNode).cardId);
  if (!targetCard) return { error: 'target card not found in vault' };
  const marker = `<!-- ws:${workspaceId}:${edgeId} --> [[${targetCard.luhmannId}]]`;

  const raw = await readFile(sourceCard.filePath, 'utf8');
  const parsed = matter(raw, {});
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
  if (edge.vaultLink || edge.vaultStructure || edge.label === 'tree') {
    return { error: 'This edge mirrors an existing vault relationship and is not owned by the workspace' };
  }

  // If a vault file was written (real-card target), undo it.
  // Deferred temp-target applies didn't touch the vault, so nothing to do there.
  if (edge.appliedToFile) {
    const raw = await readFile(edge.appliedToFile, 'utf8');
    const parsed = matter(raw, {});
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
): Promise<{ ok: true; luhmannId: string; failedEdges?: string[] } | { error: string }> {
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
  const failedEdges: string[] = [];
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
      const parsed = matter(raw, {});
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
      failedEdges.push(edge.id);
    }
  }

  return failedEdges.length > 0
    ? { ok: true, luhmannId, failedEdges }
    : { ok: true, luhmannId };
}
