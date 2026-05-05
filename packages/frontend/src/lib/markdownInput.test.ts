import { describe, expect, it } from 'vitest';
import { continueMarkdownList, indentMarkdownLines } from './markdownInput';

describe('continueMarkdownList', () => {
  it('continues unordered list items', () => {
    const out = continueMarkdownList('- first', 7, 7);
    expect(out).toEqual({ text: '- first\n- ', caret: 10 });
  });

  it('increments ordered list items', () => {
    const out = continueMarkdownList('1. first', 8, 8);
    expect(out).toEqual({ text: '1. first\n2. ', caret: 12 });
  });

  it('supports parenthesized ordered list items', () => {
    const out = continueMarkdownList('9) first', 8, 8);
    expect(out).toEqual({ text: '9) first\n10) ', caret: 13 });
  });

  it('keeps indentation', () => {
    const out = continueMarkdownList('  - child', 9, 9);
    expect(out).toEqual({ text: '  - child\n  - ', caret: 14 });
  });

  it('exits an empty list item', () => {
    const out = continueMarkdownList('intro\n- ', 8, 8);
    expect(out).toEqual({ text: 'intro\n', caret: 6 });
  });

  it('does nothing for normal lines', () => {
    expect(continueMarkdownList('plain', 5, 5)).toBeNull();
  });
});

describe('indentMarkdownLines', () => {
  it('indents the current line', () => {
    const out = indentMarkdownLines('- first', 2, 2, 'in');
    expect(out).toEqual({
      text: '  - first',
      caret: 4,
      selectionStart: 4,
      selectionEnd: 4,
    });
  });

  it('outdents the current line', () => {
    const out = indentMarkdownLines('  - first', 4, 4, 'out');
    expect(out).toEqual({
      text: '- first',
      caret: 2,
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it('indents selected lines', () => {
    const input = '- one\n- two\n- three';
    const out = indentMarkdownLines(input, 0, 11, 'in');
    expect(out.text).toBe('  - one\n  - two\n- three');
    expect(out.selectionStart).toBe(0);
    expect(out.selectionEnd).toBe(15);
  });

  it('outdents selected lines', () => {
    const input = '  - one\n  - two\n- three';
    const out = indentMarkdownLines(input, 0, 17, 'out');
    expect(out.text).toBe('- one\n- two\n- three');
    expect(out.selectionStart).toBe(0);
    expect(out.selectionEnd).toBe(13);
  });
});
