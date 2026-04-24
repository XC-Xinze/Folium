import { describe, expect, it } from 'vitest';
import { applyTrigger, detectTrigger, formatInsertion } from './editorAutocomplete';

describe('detectTrigger', () => {
  it('detects wikilink trigger', () => {
    const t = detectTrigger('hello [[wo', 10);
    expect(t).toEqual({ kind: 'wikilink', triggerStart: 6, queryStart: 8, query: 'wo' });
  });

  it('detects empty wikilink (just opened)', () => {
    const t = detectTrigger('hello [[', 8);
    expect(t).toEqual({ kind: 'wikilink', triggerStart: 6, queryStart: 8, query: '' });
  });

  it('detects transclusion (! prefix)', () => {
    const t = detectTrigger('see ![[1a2b', 11);
    expect(t).toEqual({ kind: 'transclusion', triggerStart: 4, queryStart: 7, query: '1a2b' });
  });

  it('does NOT match plain wikilink when ! prefix is there', () => {
    const t = detectTrigger('see ![[1a', 9);
    expect(t?.kind).toBe('transclusion');
  });

  it('detects tag at start of line', () => {
    const t = detectTrigger('#foo', 4);
    expect(t).toEqual({ kind: 'tag', triggerStart: 0, queryStart: 1, query: 'foo' });
  });

  it('detects tag after space', () => {
    const t = detectTrigger('hello #ba', 9);
    expect(t).toEqual({ kind: 'tag', triggerStart: 6, queryStart: 7, query: 'ba' });
  });

  it('does NOT trigger tag inside a word', () => {
    const t = detectTrigger('foo#bar', 7);
    expect(t).toBeNull();
  });

  it('does NOT trigger after closed wikilink', () => {
    const t = detectTrigger('hello [[done]] ', 15);
    expect(t).toBeNull();
  });

  it('handles CJK in tag', () => {
    const t = detectTrigger('笔记 #学习', 6);
    expect(t).toEqual({ kind: 'tag', triggerStart: 3, queryStart: 4, query: '学习' });
  });

  it('handles CJK in wikilink query', () => {
    const t = detectTrigger('看 [[主动学', 7);
    expect(t).toEqual({ kind: 'wikilink', triggerStart: 2, queryStart: 4, query: '主动学' });
  });

  it('newline before # is also a valid boundary', () => {
    const t = detectTrigger('first\n#tag', 10);
    expect(t).toEqual({ kind: 'tag', triggerStart: 6, queryStart: 7, query: 'tag' });
  });

  it('newline breaks the scan', () => {
    const t = detectTrigger('[[\nstuff', 8);
    expect(t).toBeNull();
  });

  it('returns null when no trigger', () => {
    expect(detectTrigger('plain text', 10)).toBeNull();
  });
});

describe('applyTrigger', () => {
  it('replaces wikilink trigger + query with new text', () => {
    const text = 'hello [[wo';
    const trigger = detectTrigger(text, 10)!;
    const out = applyTrigger(text, trigger, '[[1a2b]]', 10);
    expect(out.text).toBe('hello [[1a2b]]');
    expect(out.caret).toBe(14);
  });

  it('replaces tag trigger', () => {
    const text = 'note #ba';
    const trigger = detectTrigger(text, 8)!;
    const out = applyTrigger(text, trigger, '#bar ', 8);
    expect(out.text).toBe('note #bar ');
    expect(out.caret).toBe(10);
  });

  it('keeps text after caret intact', () => {
    const text = 'hello [[wo trailing';
    const trigger = detectTrigger(text, 10)!;
    const out = applyTrigger(text, trigger, '[[1a2b]]', 10);
    expect(out.text).toBe('hello [[1a2b]] trailing');
  });
});

describe('formatInsertion', () => {
  it('formats each kind correctly', () => {
    expect(formatInsertion('wikilink', '1a2b')).toBe('[[1a2b]]');
    expect(formatInsertion('transclusion', '1a2b')).toBe('![[1a2b]]');
    expect(formatInsertion('tag', 'foo')).toBe('#foo ');
  });
});
