import Database from 'better-sqlite3';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { setActiveVaultPath } from '../config.js';
import { initSchema } from '../db/schema.js';
import type { Card } from '../types.js';
import { CardRepository } from '../vault/repository.js';
import {
  applyEdge,
  createWorkspace,
  getWorkspace,
  resetWorkspacesCache,
  updateWorkspace,
  type WorkspaceEdge,
  type WorkspaceNode,
} from './workspaces.js';

function card(id: string, filePath: string, patch: Partial<Card> = {}): Card {
  return {
    luhmannId: id,
    title: patch.title ?? `Card ${id}`,
    status: patch.status ?? 'ATOMIC',
    parentId: patch.parentId ?? null,
    sortKey: patch.sortKey ?? id,
    depth: patch.depth ?? id.length,
    contentMd: patch.contentMd ?? '',
    tags: patch.tags ?? [],
    crossLinks: patch.crossLinks ?? [],
    filePath,
    mtime: patch.mtime ?? 1,
    createdAt: patch.createdAt ?? null,
    updatedAt: patch.updatedAt ?? null,
  };
}

async function setupWorkspace(edgePatch: Partial<WorkspaceEdge>) {
  const vault = await mkdtemp(join(tmpdir(), 'zk-ws-'));
  await mkdir(join(vault, '.zettel'), { recursive: true });
  setActiveVaultPath(vault);
  resetWorkspacesCache();

  const db = new Database(':memory:');
  initSchema(db);
  const repo = new CardRepository(db);
  repo.upsertMany([
    card('1', join(vault, '1.md')),
    card('2', join(vault, '2.md')),
  ]);

  const ws = await createWorkspace('Test');
  const nodes: WorkspaceNode[] = [
    { kind: 'card', id: 'n1', cardId: '1', x: 0, y: 0 },
    { kind: 'card', id: 'n2', cardId: '2', x: 300, y: 0 },
  ];
  const edges: WorkspaceEdge[] = [
    {
      id: 'e1',
      source: 'n1',
      target: 'n2',
      ...edgePatch,
    },
  ];
  await updateWorkspace(ws.id, { nodes, edges });
  return { repo, workspaceId: ws.id };
}

describe('workspace edge state guards', () => {
  beforeEach(() => {
    resetWorkspacesCache();
  });

  it('does not apply an edge that mirrors an existing vault link', async () => {
    const { repo, workspaceId } = await setupWorkspace({ vaultLink: true });

    await expect(applyEdge(repo, workspaceId, 'e1')).resolves.toEqual({
      error: 'This edge already exists in the vault',
    });
  });

  it('does not apply an edge that mirrors vault structure', async () => {
    const { repo, workspaceId } = await setupWorkspace({ label: 'tree' });

    await expect(applyEdge(repo, workspaceId, 'e1')).resolves.toEqual({
      error: 'This edge already exists in the vault',
    });
  });

  it('normalizes legacy tree edges on write', async () => {
    const { workspaceId } = await setupWorkspace({ label: 'tree' });

    const ws = await getWorkspace(workspaceId);
    expect(ws?.edges[0]?.vaultStructure).toBe(true);
    expect(ws?.edges[0]?.applied).toBe(false);
    expect(ws?.edges[0]?.vaultLink).toBe(false);
  });
});
