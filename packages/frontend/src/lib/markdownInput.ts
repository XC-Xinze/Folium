export interface TextareaEdit {
  text: string;
  caret: number;
  selectionStart?: number;
  selectionEnd?: number;
}

export function continueMarkdownList(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): TextareaEdit | null {
  if (selectionStart !== selectionEnd) return null;

  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const beforeCaret = value.slice(lineStart, selectionStart);
  const unordered = beforeCaret.match(/^(\s*)([-*+])\s+(.*)$/);
  const ordered = beforeCaret.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
  const match = unordered ?? ordered;
  if (!match) return null;

  const indent = match[1] ?? '';
  const body = unordered ? (match[3] ?? '') : (match[4] ?? '');

  if (body.trim().length === 0) {
    const nextText = value.slice(0, lineStart) + value.slice(selectionStart);
    return { text: nextText, caret: lineStart };
  }

  const marker = unordered
    ? `${indent}${match[2]} `
    : `${indent}${Number(match[2]) + 1}${match[3]} `;
  const insert = `\n${marker}`;
  return {
    text: value.slice(0, selectionStart) + insert + value.slice(selectionStart),
    caret: selectionStart + insert.length,
  };
}

export function applyTextareaEdit(
  textarea: HTMLTextAreaElement,
  setValue: (value: string) => void,
  edit: TextareaEdit,
) {
  setValue(edit.text);
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.setSelectionRange(edit.selectionStart ?? edit.caret, edit.selectionEnd ?? edit.caret);
  });
}

export function indentMarkdownLines(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  direction: 'in' | 'out',
): TextareaEdit {
  const lineStart = value.lastIndexOf('\n', Math.max(selectionStart - 1, 0)) + 1;
  const effectiveEnd =
    selectionEnd > selectionStart && value[selectionEnd - 1] === '\n'
      ? selectionEnd - 1
      : selectionEnd;
  const nextNewline = value.indexOf('\n', effectiveEnd);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');

  let removedBeforeStart = 0;
  let removedTotal = 0;
  let addedBeforeStart = 0;
  let addedTotal = 0;
  let cursor = lineStart;

  const nextLines = lines.map((line) => {
    const lineCursor = cursor;
    cursor += line.length + 1;
    if (direction === 'in') {
      if (selectionStart > lineCursor) addedBeforeStart += 2;
      addedTotal += 2;
      return `  ${line}`;
    }

    const remove = line.startsWith('\t') ? 1 : line.startsWith('  ') ? 2 : line.startsWith(' ') ? 1 : 0;
    if (remove === 0) return line;
    if (selectionStart > lineCursor) removedBeforeStart += Math.min(remove, selectionStart - lineCursor);
    removedTotal += remove;
    return line.slice(remove);
  });

  const nextBlock = nextLines.join('\n');
  const text = value.slice(0, lineStart) + nextBlock + value.slice(lineEnd);
  if (direction === 'in') {
    const nextStart = selectionStart + addedBeforeStart;
    const nextEnd = selectionEnd + addedTotal;
    return {
      text,
      caret: nextStart,
      selectionStart: selectionStart === selectionEnd ? nextStart : nextStart,
      selectionEnd: selectionStart === selectionEnd ? nextStart : nextEnd,
    };
  }

  const nextStart = Math.max(lineStart, selectionStart - removedBeforeStart);
  const nextEnd = Math.max(nextStart, selectionEnd - removedTotal);
  return {
    text,
    caret: nextStart,
    selectionStart: selectionStart === selectionEnd ? nextStart : nextStart,
    selectionEnd: selectionStart === selectionEnd ? nextStart : nextEnd,
  };
}
