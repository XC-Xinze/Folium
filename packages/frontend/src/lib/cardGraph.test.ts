import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { Card, CardSummary } from './api';
import {
  NODE_WIDTH,
  computeBackbone,
  resolveCollisions,
} from './cardGraph';

function summary(luhmannId: string, opts: Partial<CardSummary> = {}): CardSummary {
  return {
    luhmannId,
    title: opts.title ?? `Card ${luhmannId}`,
    status: opts.status ?? 'ATOMIC',
    depth: opts.depth ?? luhmannId.length,
    tags: opts.tags ?? [],
    sortKey: opts.sortKey ?? luhmannId,
    crossLinks: opts.crossLinks ?? [],
  };
}

describe('computeBackbone (ATOMIC focus)', () => {
  it('walks up to root then collects subtree', () => {
    // Tree: 1 → 1a → 1a1, 1a → 1a2
    const cards = [summary('1'), summary('1a'), summary('1a1'), summary('1a2')];
    const bb = computeBackbone('1a', cards, new Map());

    expect([...bb.ids].sort()).toEqual(['1', '1a', '1a1', '1a2']);
    // tree edges connect parent → child
    const pairs = bb.treeEdges.map((e) => `${e.source}->${e.target}`).sort();
    expect(pairs).toContain('1->1a');
    expect(pairs).toContain('1a->1a1');
    expect(pairs).toContain('1a->1a2');
  });
});

describe('computeBackbone (INDEX focus)', () => {
  it('expands only direct crossLinks, not sub-INDEX members', () => {
    // i0 (INDEX) crossLinks → [i1, 2]
    // i1 (INDEX) crossLinks → [3]   ← should NOT be auto-expanded
    const cards = [
      summary('i0', { status: 'INDEX', crossLinks: ['i1', '2'] }),
      summary('i1', { status: 'INDEX', crossLinks: ['3'] }),
      summary('2'),
      summary('3'),
    ];
    const fullCards = new Map<string, Card>([
      [
        'i0',
        {
          luhmannId: 'i0',
          title: 'i0',
          status: 'INDEX',
          parentId: null,
          sortKey: 'i0',
          depth: 1,
          contentMd: '',
          tags: [],
          crossLinks: ['i1', '2'],
          filePath: '',
          mtime: 0,
          createdAt: null,
          updatedAt: null,
        },
      ],
    ]);
    const bb = computeBackbone('i0', cards, fullCards);

    expect(bb.ids.has('i0')).toBe(true);
    expect(bb.ids.has('i1')).toBe(true);
    expect(bb.ids.has('2')).toBe(true);
    // sub-INDEX i1 's member 3 should NOT be pulled in
    expect(bb.ids.has('3')).toBe(false);
  });
});

describe('resolveCollisions', () => {
  function node(id: string, x: number, y: number): Node {
    return {
      id,
      type: 'card',
      position: { x, y },
      data: {} as Record<string, unknown>,
      width: NODE_WIDTH,
    };
  }

  it('separates two overlapping nodes', () => {
    // Two nodes placed at the same spot — must end up non-overlapping
    const nodes = [node('a', 0, 0), node('b', 50, 50)];
    const out = resolveCollisions(nodes, {});
    const [a, b] = out;
    const dx = Math.abs(a!.position.x - b!.position.x);
    const dy = Math.abs(a!.position.y - b!.position.y);
    // After resolution, at least one axis must clear NODE_WIDTH (with default padding)
    expect(dx > NODE_WIDTH || dy > 380).toBe(true);
  });

  it('keeps user-saved positions fixed', () => {
    // a is saved (fixed); b overlaps it. b should move, a stays.
    const nodes = [node('a', 0, 0), node('b', 20, 20)];
    const out = resolveCollisions(nodes, { a: { x: 0, y: 0 } });
    const aOut = out.find((n) => n.id === 'a')!;
    const bOut = out.find((n) => n.id === 'b')!;
    expect(aOut.position).toEqual({ x: 0, y: 0 });
    // b moved away from origin
    const moved = bOut.position.x !== 20 || bOut.position.y !== 20;
    expect(moved).toBe(true);
  });

  it('does nothing for non-overlapping nodes', () => {
    const nodes = [node('a', 0, 0), node('b', 1000, 1000)];
    const out = resolveCollisions(nodes, {});
    expect(out[0]!.position).toEqual({ x: 0, y: 0 });
    expect(out[1]!.position).toEqual({ x: 1000, y: 1000 });
  });
});
