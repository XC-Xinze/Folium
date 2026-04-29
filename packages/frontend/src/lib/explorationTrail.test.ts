import { describe, expect, it } from 'vitest';
import type { CardSummary } from './api';
import { nextExplorationTrail } from './explorationTrail';

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

describe('nextExplorationTrail', () => {
  const cards = [
    summary('1', { status: 'INDEX', crossLinks: ['4'] }),
    summary('1a'),
    summary('4', { status: 'INDEX' }),
    summary('7'),
  ];

  it('keeps a structural/link path visible even when focusDepth is reset', () => {
    const afterParentClick = nextExplorationTrail({
      prevTrail: ['1', '1a'],
      focusedBoxId: '1',
      previousFocusId: '1a',
      nextFocusId: '1',
      focusDepth: 0,
      cards,
    });
    expect(afterParentClick).toEqual(['1', '1a']);

    const afterLinkClick = nextExplorationTrail({
      prevTrail: afterParentClick,
      focusedBoxId: '1',
      previousFocusId: '1',
      nextFocusId: '4',
      focusDepth: 0,
      cards,
    });
    expect(afterLinkClick).toEqual(['1', '1a', '4']);
  });

  it('resets when clicking an unrelated card', () => {
    const trail = nextExplorationTrail({
      prevTrail: ['1', '1a', '4'],
      focusedBoxId: '1',
      previousFocusId: '4',
      nextFocusId: '7',
      focusDepth: 0,
      cards,
    });
    expect(trail).toEqual(['1', '7']);
  });

  it('keeps only the most recent external anchors', () => {
    const trail = nextExplorationTrail({
      prevTrail: ['1', '1a', '2', '3'],
      focusedBoxId: '1',
      previousFocusId: '3',
      nextFocusId: '4',
      focusDepth: 2,
      cards,
      maxDepth: 3,
    });
    expect(trail).toEqual(['1', '2', '3', '4']);
  });
});
