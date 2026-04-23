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
  /** 应用时插入的 link 字符串（如 [[1a2]]），撤销时按此精确删除 */
  appliedMarker?: string;
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

async function loadAll(): Promise<Record<string, Workspace>> {
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
  const next: Workspace = {
    ...cur,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
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
 * 把工作区里的一条边写回 vault：在 source 卡的正文末尾追加一个 marker + [[target]]
 *   marker 用 HTML 注释，撤销时按 marker 精确删除，不会误伤用户其它内容
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
    return { error: '只能 apply 真实卡片之间的边（temp/note 不能 apply）' };
  }

  const sourceCard = repo.getById((source as CardRefNode).cardId);
  const targetCard = repo.getById((target as CardRefNode).cardId);
  if (!sourceCard || !targetCard) return { error: 'card not found in vault' };

  if (edge.applied) return { error: '此边已经 apply 过了' };

  const marker = `<!-- ws:${workspaceId}:${edgeId} --> [[${targetCard.luhmannId}]]`;

  // 读 source 文件，在正文末尾追加
  const raw = await readFile(sourceCard.filePath, 'utf8');
  const parsed = matter(raw);
  const body = parsed.content.endsWith('\n')
    ? parsed.content + marker + '\n'
    : parsed.content + '\n\n' + marker + '\n';
  // 同时把 target 加到 frontmatter.crossLinks
  if (!Array.isArray(parsed.data.crossLinks)) parsed.data.crossLinks = [];
  if (!parsed.data.crossLinks.includes(targetCard.luhmannId)) {
    parsed.data.crossLinks.push(targetCard.luhmannId);
  }
  await writeFile(sourceCard.filePath, matter.stringify(body, parsed.data), 'utf8');

  // 标记 edge 为 applied
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
  if (!edge.applied || !edge.appliedToFile || !edge.appliedMarker) {
    return { error: '此边未 apply' };
  }

  // 读文件，删除带 marker 的行，并清理 frontmatter.crossLinks 中的 target
  const target = ws.nodes.find((n) => n.id === edge.target);
  if (!target || target.kind !== 'card') return { error: 'target not found' };
  const targetCardId = (target as CardRefNode).cardId;

  const raw = await readFile(edge.appliedToFile, 'utf8');
  const parsed = matter(raw);
  // 删除整行
  const lines = parsed.content.split('\n');
  const newLines = lines.filter((line) => !line.includes(edge.appliedMarker!));
  const newBody = newLines.join('\n');

  // 检查正文是否还有其他对 target 的 [[link]] 引用，没有就清 frontmatter
  const stillReferenced = new RegExp(
    `\\[\\[\\s*${targetCardId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*(\\|[^\\]]+)?\\s*\\]\\]`,
  ).test(newBody);
  if (!stillReferenced && Array.isArray(parsed.data.crossLinks)) {
    parsed.data.crossLinks = parsed.data.crossLinks.filter((x: unknown) => String(x) !== targetCardId);
  }
  await writeFile(edge.appliedToFile, matter.stringify(newBody, parsed.data), 'utf8');

  edge.applied = false;
  delete edge.appliedToFile;
  delete edge.appliedMarker;
  await updateWorkspace(workspaceId, { edges: ws.edges });
  return { ok: true };
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
  return { ok: true, luhmannId };
}
