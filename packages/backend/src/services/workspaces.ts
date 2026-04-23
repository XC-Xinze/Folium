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

export async function deleteWorkspace(id: string): Promise<void> {
  const map = await loadAll();
  delete map[id];
  await flush(map);
}

/* ============================================================
 * Apply / Unapply edge to vault
 * ============================================================ */

import { CardRepository } from '../vault/repository.js';

/**
 * Apply 把工作区里的一条边写回 vault。
 *   - source 必须是真实 vault 卡（要写它的 .md 文件）
 *   - target 是 vault 卡 → 标准 [[link]]
 *   - target 是 temp 卡 → 写"来自工作区 X"占位文本，标记 pending；temp 提升后会被自动替换为真 [[link]]
 *   - target/source 是 note → 拒绝
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
  if (source.kind === 'note' || target.kind === 'note') {
    return { error: '便签不能参与 apply（它们仅在工作区内存在）' };
  }
  if (source.kind !== 'card') {
    return { error: 'source 必须是真实卡片才能 apply（先把临时卡提升）' };
  }
  if (edge.applied) return { error: '此边已经 apply 过了' };

  const sourceCard = repo.getById((source as CardRefNode).cardId);
  if (!sourceCard) return { error: 'source card not found in vault' };

  const markerPrefix = `<!-- ws:${workspaceId}:${edgeId}`;
  let marker: string;
  let pendingTempIds: string[] | undefined;

  if (target.kind === 'card') {
    const targetCard = repo.getById((target as CardRefNode).cardId);
    if (!targetCard) return { error: 'target card not found in vault' };
    marker = `${markerPrefix} --> [[${targetCard.luhmannId}]]`;

    // 加到 frontmatter.crossLinks
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
  } else {
    // target 是 temp：写占位文本，等 temp 提升后自动转真链接
    const tempNode = target as TempCardNode;
    const titleHint = tempNode.title || '(未命名临时卡)';
    marker = `${markerPrefix} pending:${tempNode.id} --> 🔗 来自工作区《${ws.name}》: "${titleHint}"`;
    pendingTempIds = [tempNode.id];

    const raw = await readFile(sourceCard.filePath, 'utf8');
    const parsed = matter(raw);
    const body = parsed.content.endsWith('\n')
      ? parsed.content + marker + '\n'
      : parsed.content + '\n\n' + marker + '\n';
    await writeFile(sourceCard.filePath, matter.stringify(body, parsed.data), 'utf8');
  }

  edge.applied = true;
  edge.appliedToFile = sourceCard.filePath;
  edge.appliedMarker = marker;
  if (pendingTempIds) edge.pendingTempIds = pendingTempIds;
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
  if (!edge.applied || !edge.appliedToFile) {
    return { error: '此边未 apply' };
  }

  const raw = await readFile(edge.appliedToFile, 'utf8');
  const parsed = matter(raw);
  // 按 ws:wsId:edgeId 这个稳定前缀匹配（不论 marker 后面是 [[link]] 还是占位文本）
  const stableMarker = `<!-- ws:${workspaceId}:${edgeId}`;
  const lines = parsed.content.split('\n');
  const newLines = lines.filter((line) => !line.includes(stableMarker));
  const newBody = newLines.join('\n');

  // 如果 target 已经是真卡，检查是否还有其他对它的引用，没有就清 frontmatter
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

  edge.applied = false;
  delete edge.appliedToFile;
  delete edge.appliedMarker;
  delete edge.pendingTempIds;
  await updateWorkspace(workspaceId, { edges: ws.edges });
  void repo;
  return { ok: true };
}

/** 列出所有 workspace 中等待某 temp 节点提升的边 */
async function findEdgesPendingTemp(tempNodeId: string): Promise<Array<{ ws: Workspace; edge: WorkspaceEdge }>> {
  const all = await loadAll();
  const result: Array<{ ws: Workspace; edge: WorkspaceEdge }> = [];
  for (const ws of Object.values(all)) {
    for (const e of ws.edges) {
      if (e.applied && e.pendingTempIds?.includes(tempNodeId)) {
        result.push({ ws, edge: e });
      }
    }
  }
  return result;
}

/**
 * 把临时卡片"提升"为 vault 真实卡片：
 *   1. 校验 luhmannId 不存在
 *   2. 写 .md 文件
 *   3. 把 workspace 节点从 temp 转换为 card 引用
 *   4. 任何指向这个 temp 节点的 edge 仍然有效（节点 id 不变，只是 kind 变了）
 */
export async function tempToVault(
  workspaceId: string,
  nodeId: string,
  luhmannId: string,
): Promise<{ ok: true; luhmannId: string } | { error: string }> {
  const ws = await getWorkspace(workspaceId);
  if (!ws) return { error: 'workspace not found' };
  const node = ws.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== 'temp') return { error: '不是 temp 卡' };

  const tempNode = node as TempCardNode;

  // 用 writer 创建 vault 卡片
  const { writeNewCard } = await import('../vault/writer.js');
  try {
    await writeNewCard({
      luhmannId,
      title: tempNode.title,
      content: tempNode.content,
      status: 'ATOMIC',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }

  // 替换节点：temp → card ref
  const idx = ws.nodes.findIndex((n) => n.id === nodeId);
  ws.nodes[idx] = {
    kind: 'card',
    id: tempNode.id,
    cardId: luhmannId,
    x: tempNode.x,
    y: tempNode.y,
  };
  await updateWorkspace(workspaceId, { nodes: ws.nodes });

  // 关键：resolve 所有指向这个 temp 的 pending edges
  const pending = await findEdgesPendingTemp(tempNode.id);
  for (const { ws: pws, edge } of pending) {
    if (!edge.appliedToFile) continue;
    try {
      const raw = await readFile(edge.appliedToFile, 'utf8');
      const parsed = matter(raw);
      const stableMarker = `<!-- ws:${pws.id}:${edge.id}`;
      const newMarker = `<!-- ws:${pws.id}:${edge.id} --> [[${luhmannId}]]`;
      const lines = parsed.content.split('\n');
      const newLines = lines.map((line) => (line.includes(stableMarker) ? newMarker : line));
      const newBody = newLines.join('\n');

      // 加 luhmannId 到 frontmatter.crossLinks
      if (!Array.isArray(parsed.data.crossLinks)) parsed.data.crossLinks = [];
      if (!parsed.data.crossLinks.includes(luhmannId)) {
        parsed.data.crossLinks.push(luhmannId);
      }
      await writeFile(edge.appliedToFile, matter.stringify(newBody, parsed.data), 'utf8');

      // 更新 edge：清掉 pending，更新 marker
      edge.appliedMarker = newMarker;
      edge.pendingTempIds = (edge.pendingTempIds ?? []).filter((id) => id !== tempNode.id);
      if (edge.pendingTempIds.length === 0) delete edge.pendingTempIds;
      await updateWorkspace(pws.id, { edges: pws.edges });
    } catch (err) {
      console.error('failed to resolve pending edge', edge.id, err);
    }
  }

  return { ok: true, luhmannId };
}
