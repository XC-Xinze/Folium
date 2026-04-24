import { describe, expect, it } from 'vitest';
import { parseQueries } from './dynamicMembers';

describe('parseQueries', () => {
  it('parses single tag query', () => {
    expect(parseQueries('hello\n<!-- @members tag:foo -->\nworld')).toEqual([
      { tags: ['foo'] },
    ]);
  });

  it('parses multi-tag (OR)', () => {
    expect(parseQueries('<!-- @members tag:foo,bar,baz -->')).toEqual([
      { tags: ['foo', 'bar', 'baz'] },
    ]);
  });

  it('parses multiple directives separately', () => {
    const md = `intro
<!-- @members tag:a -->
middle
<!-- @members tag:b,c -->`;
    expect(parseQueries(md)).toEqual([{ tags: ['a'] }, { tags: ['b', 'c'] }]);
  });

  it('lowercases tag names', () => {
    expect(parseQueries('<!-- @members tag:FOO -->')).toEqual([{ tags: ['foo'] }]);
  });

  it('ignores whitespace', () => {
    expect(parseQueries('<!--   @members   tag:foo,  bar  -->')).toEqual([
      { tags: ['foo', 'bar'] },
    ]);
  });

  it('returns empty for unrecognized syntax', () => {
    expect(parseQueries('<!-- @members invalid -->')).toEqual([]);
    expect(parseQueries('no directive here')).toEqual([]);
  });

  it('handles CJK tags', () => {
    expect(parseQueries('<!-- @members tag:机器学习,深度学习 -->')).toEqual([
      { tags: ['机器学习', '深度学习'] },
    ]);
  });
});
