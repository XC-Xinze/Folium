import { describe, expect, it } from 'vitest';
import { countUnlinkedHits, stripWikilinks, titleKeywords } from './links.js';

describe('stripWikilinks', () => {
  it('removes wikilink wrappers and their contents', () => {
    expect(stripWikilinks('see [[1a]] and [[Title|alias]] for more')).toBe(
      'see  and  for more',
    );
  });

  it('leaves plain text untouched', () => {
    expect(stripWikilinks('plain RBF kernel notes')).toBe('plain RBF kernel notes');
  });
});

describe('countUnlinkedHits', () => {
  it('counts ASCII phrase with word boundary', () => {
    // "RBF" matches isolated, but not inside "subRBFworld"
    const body = 'about RBF kernels and subRBFworld nonsense, RBF again';
    expect(countUnlinkedHits(body, 'RBF')).toBe(2);
  });

  it('is case-insensitive for ASCII', () => {
    expect(countUnlinkedHits('rbf and RBF', 'RBF')).toBe(2);
  });

  it('does not match across word boundaries (numeric)', () => {
    // luhmannId "1" should NOT match inside "10" or "11"
    const body = 'card 1 references card 10 and card 11';
    expect(countUnlinkedHits(body, '1')).toBe(0); // length < 2 → skipped
    expect(countUnlinkedHits(body, '10')).toBe(1);
  });

  it('handles CJK without word boundary (substring)', () => {
    // \b doesn't work well with CJK so we fall back to plain substring.
    const body = '机器学习是核函数的基础。机器学习在深度学习里也用';
    expect(countUnlinkedHits(body, '机器学习')).toBe(2);
  });

  it('returns 0 for very short phrases', () => {
    expect(countUnlinkedHits('aaa', 'a')).toBe(0);
    expect(countUnlinkedHits('', 'foo')).toBe(0);
  });

  it('escapes regex metacharacters in the phrase', () => {
    // Title with regex-special chars must not throw.
    expect(countUnlinkedHits('see C++ wins', 'C++')).toBe(1);
    expect(countUnlinkedHits('a.b matches', 'a.b')).toBe(1);
  });
});

describe('titleKeywords', () => {
  it('splits CJK title on conjunctions', () => {
    const out = titleKeywords('主动学习与查询策略');
    expect(out).toContain('主动学习与查询策略'); // full
    expect(out).toContain('主动学习'); // prefix segment
    expect(out).toContain('查询策略'); // suffix segment
  });

  it('splits English title on connectors without breaking words', () => {
    const out = titleKeywords('Active Learning vs Random Sampling');
    expect(out).toContain('Active Learning vs Random Sampling');
    expect(out).toContain('Active Learning');
    expect(out).toContain('Random Sampling');
    // critically: should NOT have produced character fragments like 'A' or 'L'
    expect(out.every((s) => s.length >= 2)).toBe(true);
  });

  it('returns the title unchanged when no splitter', () => {
    expect(titleKeywords('RBF')).toEqual(['RBF']);
    expect(titleKeywords('半监督学习')).toEqual(['半监督学习']);
  });
});

describe('Logseq-style unlinked references (integration of strip + count)', () => {
  it('counts only unlinked mentions (ignores [[wrapped]])', () => {
    // Body has "RBF" twice as plain text and once inside [[]]
    const body = 'I love RBF kernels. See [[RBF]] for the wikilink. Plus RBF rocks.';
    const stripped = stripWikilinks(body);
    expect(countUnlinkedHits(stripped, 'RBF')).toBe(2); // not counting the [[]] one
  });
});
