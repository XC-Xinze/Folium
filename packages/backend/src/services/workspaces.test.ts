import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { beforeEach, describe, expect, it } from 'vitest';
import { setActiveVaultPath } from '../config.js';
import { initSchema } from '../db/schema.js';
import type { Card } from '../types.js';
import { CardRepository } from '../vault/repository.js';
import {
  applyEdge,
  createWorkspace,
  getWorkspace,
  listWorkspaceLinksFor,
  repairWorkspaces,
  resetWorkspacesCache,
  unapplyEdge,
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
  await writeFile(
    join(vault, '1.md'),
    matter.stringify('Source body\n', { luhmannId: '1', title: 'Card 1', crossLinks: [] }),
    'utf8',
  );
  await writeFile(
    join(vault, '2.md'),
    matter.stringify('Target body\n', { luhmannId: '2', title: 'Card 2', crossLinks: [] }),
    'utf8',
  );
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

  it('applies a draft card edge to the source file and can unapply its marker', async () => {
    const { repo, workspaceId } = await setupWorkspace({});

    await expect(applyEdge(repo, workspaceId, 'e1')).resolves.toEqual({ ok: true });
    let source = matter(await readFile(repo.getById('1')!.filePath, 'utf8'));
    expect(source.content).toContain(`<!-- ws:${workspaceId}:e1 --> [[2]]`);
    expect(source.data.crossLinks).toContain('2');
    expect((await getWorkspace(workspaceId))?.edges[0]?.applied).toBe(true);

    await expect(unapplyEdge(repo, workspaceId, 'e1')).resolves.toEqual({ ok: true });
    source = matter(await readFile(repo.getById('1')!.filePath, 'utf8'));
    expect(source.content).not.toContain(`<!-- ws:${workspaceId}:e1 -->`);
    expect(source.data.crossLinks ?? []).not.toContain('2');
    expect((await getWorkspace(workspaceId))?.edges[0]?.applied).toBe(false);
  });

  it('keeps crossLinks when unapplying one marker but another body wikilink remains', async () => {
    const { repo, workspaceId } = await setupWorkspace({});
    const sourcePath = repo.getById('1')!.filePath;
    await writeFile(
      sourcePath,
      matter.stringify('Manual reference [[2]]\n', { luhmannId: '1', title: 'Card 1', crossLinks: ['2'] }),
      'utf8',
    );

    await applyEdge(repo, workspaceId, 'e1');
    await unapplyEdge(repo, workspaceId, 'e1');
    const source = matter(await readFile(sourcePath, 'utf8'));
    expect(source.content).toContain('Manual reference [[2]]');
    expect(source.data.crossLinks).toContain('2');
  });

  it('repairs duplicate card nodes and dangling workspace edges', async () => {
    const { workspaceId } = await setupWorkspace({});
    await updateWorkspace(workspaceId, {
      nodes: [
        { kind: 'card', id: 'n1', cardId: '1', x: 0, y: 0 },
        { kind: 'card', id: 'n1-dupe', cardId: '1', x: 50, y: 50 },
        { kind: 'card', id: 'n2', cardId: '2', x: 300, y: 0 },
      ],
      edges: [
        { id: 'e1', source: 'n1-dupe', target: 'n2', label: 'rel' },
        { id: 'e2', source: 'n1', target: 'n2', label: 'rel' },
        { id: 'e3', source: 'missing', target: 'n2' },
      ],
    });

    await expect(repairWorkspaces()).resolves.toMatchObject({
      workspacesScanned: 1,
      nodesRemoved: 1,
      edgesRemoved: 2,
    });
    const ws = await getWorkspace(workspaceId);
    expect(ws?.nodes.filter((node) => node.kind === 'card' && node.cardId === '1')).toHaveLength(1);
    expect(ws?.edges).toHaveLength(1);
    expect(ws?.edges[0]).toMatchObject({ source: 'n1', target: 'n2', label: 'rel' });
  });

  it('does not expose card-to-card draft links to the vault canvas overlay', async () => {
    const { workspaceId } = await setupWorkspace({});
    await updateWorkspace(workspaceId, {
      nodes: [
        { kind: 'card', id: 'n1', cardId: '1', x: 0, y: 0 },
        { kind: 'card', id: 'n1-dupe', cardId: '1', x: 40, y: 40 },
        { kind: 'card', id: 'n2', cardId: '2', x: 300, y: 0 },
      ],
      edges: [
        { id: 'e1', source: 'n1-dupe', target: 'n2', label: 'draft' },
        { id: 'e2', source: 'n1', target: 'n2', label: 'draft' },
      ],
    });

    await repairWorkspaces();
    const links = await listWorkspaceLinksFor(['1']);
    expect(links).toHaveLength(0);
    expect(await getWorkspace(workspaceId)).toBeTruthy();
  });

  it('exposes temp edges that touch visible vault cards', async () => {
    const { workspaceId } = await setupWorkspace({});
    await updateWorkspace(workspaceId, {
      nodes: [
        { kind: 'card', id: 'n1', cardId: '1', x: 0, y: 0 },
        { kind: 'temp', id: 'tmp1', title: 'Temp idea', content: 'draft', x: 300, y: 0 },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'tmp1', label: 'draft' },
      ],
    });

    const links = await listWorkspaceLinksFor(['1']);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      workspaceId,
      source: { kind: 'card', id: '1' },
      target: { kind: 'temp', id: 'tmp1', title: 'Temp idea', content: 'draft' },
    });
  });
});
