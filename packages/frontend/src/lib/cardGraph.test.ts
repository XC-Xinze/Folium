import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { Card, CardSummary } from './api';
import {
  NODE_WIDTH,
  applyAnchorPositions,
  buildGraph,
  buildTagGraph,
  computeBackbone,
  resolveCollisions,
  tempGhostId,
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

function card(luhmannId: string, opts: Partial<Card> = {}): Card {
  return {
    luhmannId,
    title: opts.title ?? `Card ${luhmannId}`,
    status: opts.status ?? 'ATOMIC',
    parentId: opts.parentId ?? null,
    sortKey: opts.sortKey ?? luhmannId,
    depth: opts.depth ?? luhmannId.length,
    contentMd: opts.contentMd ?? '',
    tags: opts.tags ?? ['x'],
    crossLinks: opts.crossLinks ?? [],
    filePath: opts.filePath ?? `${luhmannId}.md`,
    mtime: opts.mtime ?? 0,
    createdAt: opts.createdAt ?? null,
    updatedAt: opts.updatedAt ?? null,
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

describe('buildGraph link visibility', () => {
  it('pulls direct real links related to the current box', () => {
    const cards = [
      summary('1', { status: 'INDEX', crossLinks: ['4'] }),
      summary('1a'),
      summary('1b'),
      summary('4', { status: 'INDEX' }),
      summary('4a'),
    ];
    const graph = buildGraph({
      allCards: cards,
      fullCards: new Map(),
      focusedBoxId: '1',
      focusedCardId: '4',
      tagAnchorIds: ['1', '1a', '4'],
      relatedBatch: {},
      showPotential: false,
      showTagRelated: false,
      showCrossLinks: true,
      showBoxCards: false,
      workspaceLinks: [],
    });

    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['1', '1a', '4']);
    expect(graph.nodes.some((n) => n.id === '1b')).toBe(false);
    expect(graph.nodes.some((n) => n.id === '4a')).toBe(false);
    expect(graph.edges.some((e) => e.id === 'cross:1->4')).toBe(true);
  });

  it('pulls linked cards from visible box members', () => {
    const cards = [
      summary('1', { status: 'INDEX' }),
      summary('1a', { crossLinks: ['2'] }),
      summary('1b', { crossLinks: ['1a'] }),
      summary('2'),
    ];
    const graph = buildGraph({
      allCards: cards,
      fullCards: new Map(),
      focusedBoxId: '1',
      focusedCardId: '1a',
      tagAnchorIds: ['1'],
      relatedBatch: {},
      showPotential: false,
      showTagRelated: false,
      showCrossLinks: true,
      showBoxCards: true,
      workspaceLinks: [],
    });

    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['1', '1a', '1b', '2']);
    expect(graph.edges.some((e) => e.id === 'cross:1b->1a')).toBe(true);
    expect(graph.edges.some((e) => e.id === 'cross:1a->2')).toBe(true);
  });

  it('does not expand a second ring from imported cross-link cards', () => {
    const cards = [
      summary('1', { status: 'INDEX' }),
      summary('1a', { crossLinks: ['2'] }),
      summary('2', { crossLinks: ['9'] }),
      summary('9'),
    ];
    const graph = buildGraph({
      allCards: cards,
      fullCards: new Map(),
      focusedBoxId: '1',
      focusedCardId: '2',
      tagAnchorIds: ['1'],
      relatedBatch: {},
      showPotential: false,
      showTagRelated: false,
      showCrossLinks: true,
      showBoxCards: true,
      workspaceLinks: [],
    });

    expect(graph.nodes.some((n) => n.id === '2')).toBe(true);
    expect(graph.edges.some((e) => e.id === 'cross:1a->2')).toBe(true);
    expect(graph.nodes.some((n) => n.id === '9')).toBe(false);
    expect(graph.edges.some((e) => e.id === 'cross:2->9')).toBe(false);
  });

  it('does not let hidden Box members drive cross-link expansion', () => {
    const cards = [
      summary('1', { status: 'INDEX' }),
      summary('1a', { crossLinks: ['5'] }),
      summary('1b', { crossLinks: ['6'] }),
      summary('5'),
      summary('6'),
    ];
    const graph = buildGraph({
      allCards: cards,
      fullCards: new Map(),
      focusedBoxId: '1',
      focusedCardId: '1a',
      tagAnchorIds: ['1', '1a'],
      relatedBatch: {},
      showPotential: false,
      showTagRelated: false,
      showCrossLinks: true,
      showBoxCards: false,
      workspaceLinks: [],
    });

    expect(graph.nodes.some((n) => n.id === '5')).toBe(true);
    expect(graph.nodes.some((n) => n.id === '1b')).toBe(false);
    expect(graph.nodes.some((n) => n.id === '6')).toBe(false);
  });

  it('only expands potential links from the focused card', () => {
    const cards = [
      summary('1', { status: 'INDEX' }),
      summary('1a'),
      summary('1b'),
      summary('5'),
      summary('6'),
    ];
    const graph = buildGraph({
      allCards: cards,
      fullCards: new Map(),
      focusedBoxId: '1',
      focusedCardId: '1a',
      tagAnchorIds: ['1', '1a'],
      relatedBatch: {
        '1a': {
          tagRelated: [],
          potential: [{ luhmannId: '5', title: 'Card 5', score: 0.8, reasons: ['shared term'] }],
        },
        '1b': {
          tagRelated: [],
          potential: [{ luhmannId: '6', title: 'Card 6', score: 0.8, reasons: ['shared term'] }],
        },
      },
      showPotential: true,
      showTagRelated: false,
      showCrossLinks: false,
      showBoxCards: true,
      workspaceLinks: [],
    });

    expect(graph.nodes.some((n) => n.id === '1b')).toBe(true);
    expect(graph.nodes.some((n) => n.id === '5')).toBe(true);
    expect(graph.nodes.some((n) => n.id === '6')).toBe(false);
    expect(graph.edges.some((e) => e.id === 'pot:1a->5')).toBe(true);
    expect(graph.edges.some((e) => e.id === 'pot:1b->6')).toBe(false);
  });

  it('keeps focus potential hidden when the potential filter is off', () => {
    const cards = [
      summary('1', { status: 'INDEX' }),
      summary('1a'),
      summary('5'),
    ];
    const graph = buildGraph({
      allCards: cards,
      fullCards: new Map(),
      focusedBoxId: '1',
      focusedCardId: '1a',
      tagAnchorIds: ['1'],
      relatedBatch: {
        '1a': {
          tagRelated: [],
          potential: [{ luhmannId: '5', title: 'Card 5', score: 0.8, reasons: ['shared term'] }],
        },
      },
      showPotential: false,
      showTagRelated: false,
      showCrossLinks: false,
      showBoxCards: true,
      workspaceLinks: [],
    });

    expect(graph.nodes.some((n) => n.id === '1a')).toBe(true);
    expect(graph.nodes.some((n) => n.id === '5')).toBe(false);
    expect(graph.edges.some((e) => e.id === 'pot:1a->5')).toBe(false);
  });

  it('keeps an external focus card visible when every relation filter is off', () => {
    const cards = [
      summary('1', { status: 'INDEX' }),
      summary('1a'),
      summary('3', { status: 'INDEX' }),
    ];
    const graph = buildGraph({
      allCards: cards,
      fullCards: new Map(),
      focusedBoxId: '1',
      focusedCardId: '3',
      tagAnchorIds: ['1', '3'],
      relatedBatch: {},
      showPotential: false,
      showTagRelated: false,
      showCrossLinks: false,
      showBoxCards: false,
      workspaceLinks: [],
    });

    expect(graph.nodes.map((n) => n.id)).toEqual(['3']);
    expect(graph.edges).toEqual([]);
  });

  it('falls back to the current box entry when filters are off and focus is missing', () => {
    const cards = [
      summary('1', { status: 'INDEX' }),
      summary('1a'),
    ];
    const graph = buildGraph({
      allCards: cards,
      fullCards: new Map(),
      focusedBoxId: '1',
      focusedCardId: '',
      tagAnchorIds: ['1'],
      relatedBatch: {},
      showPotential: false,
      showTagRelated: false,
      showCrossLinks: false,
      showBoxCards: false,
      workspaceLinks: [],
    });

    expect(graph.nodes.map((n) => n.id)).toEqual(['1']);
    expect(graph.edges).toEqual([]);
  });

  it('only overlays workspace links that connect a real card to a temp card', () => {
    const cards = [
      summary('1', { status: 'INDEX' }),
      summary('1a'),
      summary('2'),
    ];
    const graph = buildGraph({
      allCards: cards,
      fullCards: new Map(),
      focusedBoxId: '1',
      focusedCardId: '1a',
      tagAnchorIds: ['1'],
      relatedBatch: {},
      showPotential: false,
      showTagRelated: false,
      showCrossLinks: true,
      showBoxCards: true,
      workspaceLinks: [
        {
          workspaceId: 'w1',
          workspaceName: 'Workspace',
          edgeId: 'card-card',
          source: { kind: 'card', id: '1a' },
          target: { kind: 'card', id: '2' },
        },
        {
          workspaceId: 'w1',
          workspaceName: 'Workspace',
          edgeId: 'card-temp',
          source: { kind: 'card', id: '1a' },
          target: { kind: 'temp', id: 'tmp1', title: 'Temp thought', content: 'Draft' },
        },
      ],
    });

    expect(graph.nodes.some((n) => n.id === '2')).toBe(false);
    expect(graph.edges.some((e) => e.id === 'ws:w1:card-card')).toBe(false);
    expect(graph.nodes.some((n) => n.id === tempGhostId('w1', 'tmp1'))).toBe(true);
    expect(graph.edges.some((e) => e.id === 'ws:w1:card-temp')).toBe(true);
  });
});

describe('buildTagGraph', () => {
  it('deduplicates reciprocal links between tag members visually', () => {
    const graph = buildTagGraph('x', [
      card('1a', { crossLinks: ['1b'] }),
      card('1b', { crossLinks: ['1a'] }),
    ]);

    const crossEdges = graph.edges.filter((e) => String(e.id).startsWith('cross:'));
    expect(crossEdges).toHaveLength(1);
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
