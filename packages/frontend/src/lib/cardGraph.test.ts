import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { CardSummary } from './api';
import {
  NODE_WIDTH,
  applyAnchorPositions,
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

describe('computeBackbone', () => {
  it('box = Folgezettel subtree of focused id; does NOT climb to root', () => {
    // Tree: 1 → 1a → 1a1, 1a → 1a2
    // 焦点 1a → 只看 1a 子树（1a + 1a1 + 1a2），不要把 1 拉进来
    const cards = [summary('1'), summary('1a'), summary('1a1'), summary('1a2')];
    const bb = computeBackbone('1a', cards, new Map());

    expect([...bb.ids].sort()).toEqual(['1a', '1a1', '1a2']);
    const pairs = bb.treeEdges.map((e) => `${e.source}->${e.target}`).sort();
    expect(pairs).toContain('1a->1a1');
    expect(pairs).toContain('1a->1a2');
    expect(pairs).not.toContain('1->1a');
  });

  it('crossLinks do NOT introduce backbone members; box is structural', () => {
    // 1 是 INDEX（derived：有子 1a），其 crossLinks 指向 2 和 3 不属于 1 的 Folgezettel 子树
    // 那 2 和 3 不应进入 box 1 的 backbone（它们走 cross-flank 边渲染）
    const cards = [
      summary('1', { status: 'INDEX', crossLinks: ['2', '3'] }),
      summary('1a', { depth: 2 }),
      summary('2'),
      summary('3'),
    ];
    const bb = computeBackbone('1', cards, new Map());

    expect(bb.ids.has('1')).toBe(true);
    expect(bb.ids.has('1a')).toBe(true); // Folgezettel 子
    expect(bb.ids.has('2')).toBe(false); // crossLink 但不是 Folgezettel 子
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

  it('does not move two user-saved nodes even if they are intentionally close', () => {
    const nodes = [node('a', 0, 0), node('b', 120, 0)];
    const out = resolveCollisions(nodes, {
      a: { x: 0, y: 0 },
      b: { x: 120, y: 0 },
    });

    expect(out.find((n) => n.id === 'a')?.position).toEqual({ x: 0, y: 0 });
    expect(out.find((n) => n.id === 'b')?.position).toEqual({ x: 120, y: 0 });
  });

  it('does nothing for non-overlapping nodes', () => {
    const nodes = [node('a', 0, 0), node('b', 1000, 1000)];
    const out = resolveCollisions(nodes, {});
    expect(out[0]!.position).toEqual({ x: 0, y: 0 });
    expect(out[1]!.position).toEqual({ x: 1000, y: 1000 });
  });
});

describe('applyAnchorPositions', () => {
  function graphNode(id: string, variant: string, x: number, y: number): Node {
    return {
      id,
      type: 'card',
      position: { x, y },
      data: { variant } as Record<string, unknown>,
      width: NODE_WIDTH,
    };
  }

  it('respects saved positions for external potential nodes and workspace temp ghosts', () => {
    const nodes = [
      graphNode('1', 'tree', 0, 0),
      graphNode('2', 'potential', 500, 0),
      graphNode('__ws-temp::w1::n1', 'potential', 900, 0),
    ];
    const out = applyAnchorPositions(nodes, [], {
      '2': { x: 100, y: 80 },
      '__ws-temp::w1::n1': { x: -120, y: 240 },
    });

    expect(out.find((n) => n.id === '2')?.position).toEqual({ x: 100, y: 80 });
    expect(out.find((n) => n.id === '__ws-temp::w1::n1')?.position).toEqual({ x: -120, y: 240 });
  });
});
