import { describe, expect, it } from 'vitest';
import { countWords, relativeTime } from './cardStats';

describe('countWords', () => {
  it('counts Latin words by whitespace', () => {
    expect(countWords('Hello world')).toBe(2);
    expect(countWords('one  two   three')).toBe(3);
  });

  it('counts CJK characters individually', () => {
    expect(countWords('你好世界')).toBe(4);
  });

  it('mixes CJK + Latin', () => {
    expect(countWords('Hello 世界')).toBe(3); // 1 latin word + 2 CJK chars
  });

  it('strips markdown noise', () => {
    expect(countWords('# Heading\n\n[link](url) text')).toBe(2); // "Heading", "text"
    expect(countWords('see [[1a]] for more')).toBe(3); // "see", "for", "more"
    expect(countWords('```\ncode block\n```\nplain text')).toBe(2); // "plain", "text"
  });

  it('returns 0 for empty', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
  });
});

describe('relativeTime', () => {
  it('returns "just now" for recent', () => {
    expect(relativeTime(Date.now())).toBe('just now');
  });

  it('returns minutes', () => {
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5m ago');
  });

  it('returns hours', () => {
    expect(relativeTime(Date.now() - 3 * 3600_000)).toBe('3h ago');
  });

  it('returns days', () => {
    expect(relativeTime(Date.now() - 2 * 86400_000)).toBe('2d ago');
  });

  it('returns absolute date for >30 days', () => {
    const old = Date.now() - 60 * 86400_000;
    const result = relativeTime(old);
    expect(result).toMatch(/^[A-Z][a-z]{2} \d+$/); // e.g. "Feb 23"
  });

  it('handles null / NaN', () => {
    expect(relativeTime(null)).toBe('');
    expect(relativeTime('not-a-date')).toBe('');
  });
});
