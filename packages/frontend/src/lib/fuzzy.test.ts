import { describe, expect, it } from 'vitest';
import { fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it('exact equality wins', () => {
    expect(fuzzyScore('rbf', 'RBF')).toBe(1000);
  });

  it('prefix beats substring', () => {
    const prefix = fuzzyScore('act', 'Active Learning');
    const substring = fuzzyScore('act', 'Practical Action');
    expect(prefix).toBeGreaterThan(substring);
  });

  it('substring beats subsequence', () => {
    const substring = fuzzyScore('alr', 'AlR'); // exact-ish substring
    const subsequence = fuzzyScore('alr', 'A long road'); // subsequence
    expect(substring).toBeGreaterThan(subsequence);
  });

  it('returns 0 when no match', () => {
    expect(fuzzyScore('xyz', 'foo bar baz')).toBe(0);
  });

  it('subsequence with smaller gap scores higher', () => {
    const close = fuzzyScore('abc', 'aabbcc');
    const far = fuzzyScore('abc', 'a----b----c');
    expect(close).toBeGreaterThan(far);
  });

  it('empty query returns 0', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
});
