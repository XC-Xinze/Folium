import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  depth,
  parentId,
  parseSegments,
  sortKey,
} from './luhmann.js';

describe('parseSegments', () => {
  it('alternates num/alpha', () => {
    expect(parseSegments('1a2b')).toEqual([
      { kind: 'num', value: 1 },
      { kind: 'alpha', value: 'a' },
      { kind: 'num', value: 2 },
      { kind: 'alpha', value: 'b' },
    ]);
  });

  it('handles slash separator', () => {
    expect(parseSegments('21/3d7a6')).toEqual([
      { kind: 'num', value: 21 },
      { kind: 'num', value: 3 },
      { kind: 'alpha', value: 'd' },
      { kind: 'num', value: 7 },
      { kind: 'alpha', value: 'a' },
      { kind: 'num', value: 6 },
    ]);
  });

  it('lowercases alpha', () => {
    expect(parseSegments('1A')).toEqual([
      { kind: 'num', value: 1 },
      { kind: 'alpha', value: 'a' },
    ]);
  });

  it('returns empty for empty / whitespace', () => {
    expect(parseSegments('')).toEqual([]);
    expect(parseSegments('   ')).toEqual([]);
  });
});

describe('depth', () => {
  it('counts segments', () => {
    expect(depth('1')).toBe(1);
    expect(depth('1a')).toBe(2);
    expect(depth('1a2')).toBe(3);
    expect(depth('1a2b3')).toBe(5);
  });
});

describe('parentId', () => {
  it('strips last segment', () => {
    expect(parentId('1a2')).toBe('1a');
    expect(parentId('1a')).toBe('1');
    expect(parentId('1a2b')).toBe('1a2');
  });

  it('returns null at root', () => {
    expect(parentId('1')).toBeNull();
    expect(parentId('')).toBeNull();
  });
});

describe('sortKey', () => {
  it('orders numerically not lexicographically', () => {
    // The key bug this prevents: "1a10" sorting before "1a2" lexicographically.
    const ids = ['1a10', '1a2', '1a1'];
    const sorted = ids.slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    expect(sorted).toEqual(['1a1', '1a2', '1a10']);
  });

  it('orders across mixed depths', () => {
    const ids = ['1a', '1', '1a1', '1b'];
    const sorted = ids.slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    expect(sorted).toEqual(['1', '1a', '1a1', '1b']);
  });
});

describe('canonicalize', () => {
  it('removes separators and whitespace', () => {
    expect(canonicalize('21/3d7a6')).toBe('213d7a6');
    expect(canonicalize(' 1a 2 ')).toBe('1a2');
    expect(canonicalize('1A')).toBe('1a');
  });
});
