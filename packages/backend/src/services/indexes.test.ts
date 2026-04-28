import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../db/schema.js';
import { CardRepository } from '../vault/repository.js';
import type { Card } from '../types.js';
import { buildIndexTree } from './indexes.js';

function makeRepo() {
  const db = new Database(':memory:');
  initSchema(db);
  return { db, repo: new CardRepository(db) };
}

function card(id: string, patch: Partial<Card> = {}): Card {
  return {
    luhmannId: id,
    title: patch.title ?? `Card ${id}`,
    status: patch.status ?? 'ATOMIC',
    parentId: patch.parentId ?? (id.length > 1 ? id.slice(0, -1) : null),
    sortKey: patch.sortKey ?? id,
    depth: patch.depth ?? id.length,
    contentMd: patch.contentMd ?? '',
    tags: patch.tags ?? [],
    crossLinks: patch.crossLinks ?? [],
    filePath: patch.filePath ?? `/tmp/${id}.md`,
    mtime: patch.mtime ?? 1,
    createdAt: patch.createdAt ?? null,
    updatedAt: patch.updatedAt ?? null,
  };
}

describe('buildIndexTree', () => {
  it('includes top-level cards as index roots even without children', () => {
    const { db, repo } = makeRepo();
    repo.upsertMany([
      card('1', { parentId: null }),
      card('2', { parentId: null }),
      card('4', { parentId: null }),
      card('1a', { parentId: '1' }),
    ]);

    const tree = buildIndexTree(db, repo);
    expect(tree.map((n) => n.luhmannId).sort()).toEqual(['1', '2', '4']);
    expect(tree.find((n) => n.luhmannId === '4')?.status).toBe('INDEX');
  });

  it('nests index cards that are linked from another index', () => {
    const { db, repo } = makeRepo();
    repo.upsertMany([
      card('1', { parentId: null, crossLinks: ['2'] }),
      card('2', { parentId: null }),
      card('3', { parentId: null }),
    ]);

    const tree = buildIndexTree(db, repo);
    expect(tree.map((n) => n.luhmannId).sort()).toEqual(['1', '3']);
    expect(tree.find((n) => n.luhmannId === '1')?.children.map((n) => n.luhmannId)).toEqual(['2']);
  });
});
