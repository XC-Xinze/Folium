import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { beforeEach, describe, expect, it } from 'vitest';
import { setActiveVaultPath } from '../config.js';
import { initSchema } from '../db/schema.js';
import { parseCardFile } from '../vault/parser.js';
import { CardRepository } from '../vault/repository.js';
import { resetPositionsCache } from './positions.js';
import { reparentCard } from './reparent.js';
import { resetStarredCache } from './starred.js';
import {
  createWorkspace,
  getWorkspace,
  resetWorkspacesCache,
  updateWorkspace,
  type WorkspaceEdge,
  type WorkspaceNode,
} from './workspaces.js';

beforeEach(() => {
  (matter as typeof matter & { clearCache: () => void }).clearCache();
  resetPositionsCache();
  resetStarredCache();
  resetWorkspacesCache();
});

async function writeCard(vault: string, id: string, body: string, data: Record<string, unknown> = {}) {
  await writeFile(
    join(vault, `${id}.md`),
    matter.stringify(body, { luhmannId: id, title: `Card ${id}`, crossLinks: [], ...data }),
    'utf8',
  );
}

async function repoFromVault(vault: string) {
  const db = new Database(':memory:');
  initSchema(db);
  const repo = new CardRepository(db);
  const cards = await Promise.all(
    ['1', '1a', '2'].map(async (id) => parseCardFile(join(vault, `${id}.md`))),
  );
  repo.upsertMany(cards.filter((card): card is NonNullable<typeof card> => !!card));
  return { db, repo };
}

describe('reparent data safety', () => {
  it('renames vault references and keeps workspace real-card nodes attached to renamed cards', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zk-reparent-'));
    await mkdir(join(vault, '.zettel'), { recursive: true });
    setActiveVaultPath(vault);

    await writeCard(vault, '1', 'Source card\n');
    await writeCard(vault, '1a', 'Child card\n');
    await writeCard(vault, '2', 'Target parent links [[1|source]] and [[1a]]\n', {
      crossLinks: ['1', '1a'],
    });
    const { db, repo } = await repoFromVault(vault);

    const ws = await createWorkspace('Reparent workspace');
    const nodes: WorkspaceNode[] = [
      { kind: 'card', id: 'n-source', cardId: '1', x: 0, y: 0 },
      { kind: 'card', id: 'n-child', cardId: '1a', x: 200, y: 0 },
    ];
    const edges: WorkspaceEdge[] = [{ id: 'e1', source: 'n-source', target: 'n-child' }];
    await updateWorkspace(ws.id, { nodes, edges });

    const result = await reparentCard(db, repo, '1', '2');

    expect(result.renames).toEqual({ '1': '2a', '1a': '2a1' });
    expect(result.workspacesUpdated).toBe(1);
    const target = matter(await readFile(join(vault, '2.md'), 'utf8'));
    expect(target.content).toContain('[[2a|source]]');
    expect(target.content).toContain('[[2a1]]');
    expect(target.data.crossLinks).toEqual(['2a', '2a1']);

    const updated = await getWorkspace(ws.id);
    expect(updated?.nodes).toEqual([
      { kind: 'card', id: 'n-source', cardId: '2a', x: 0, y: 0 },
      { kind: 'card', id: 'n-child', cardId: '2a1', x: 200, y: 0 },
    ]);
    expect(updated?.edges).toHaveLength(1);
    expect(updated?.edges[0]).toMatchObject({ source: 'n-source', target: 'n-child' });
  });
});
