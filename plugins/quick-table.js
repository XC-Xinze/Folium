export const manifest = {
  id: 'folium.quick-table',
  name: 'Quick Table',
  version: '0.1.1',
  minAppVersion: '1.5.0',
  mobile: true,
};

function activeTextarea() {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return el;
  return null;
}

function isVisibleTextarea(el) {
  if (!(el instanceof HTMLTextAreaElement)) return false;
  if (!el.isConnected || el.disabled || el.readOnly) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 24) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
}

function bestVisibleTextarea() {
  const candidates = [...document.querySelectorAll('textarea')].filter(isVisibleTextarea);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return br.width * br.height - ar.width * ar.height;
  })[0];
}

function createTextareaTracker() {
  let last = null;
  const remember = (event) => {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) last = target;
  };
  window.addEventListener('focusin', remember, true);
  return {
    get() {
      const active = activeTextarea();
      if (isVisibleTextarea(active)) return active;
      if (isVisibleTextarea(last)) return last;
      return bestVisibleTextarea();
    },
    dispose() {
      window.removeEventListener('focusin', remember, true);
    },
  };
}

function setTextareaValue(textarea, value, selectionStart, selectionEnd = selectionStart) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(textarea, value);
  else textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  textarea.setSelectionRange(selectionStart, selectionEnd);
}

function insertAtSelection(textarea, text, selectOffset = 0) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const prefix = value.slice(0, start);
  const suffix = value.slice(end);
  const spacerBefore = prefix && !prefix.endsWith('\n') ? '\n' : '';
  const spacerAfter = suffix && !suffix.startsWith('\n') ? '\n' : '';
  const next = `${prefix}${spacerBefore}${text}${spacerAfter}${suffix}`;
  const cursor = prefix.length + spacerBefore.length + selectOffset;
  setTextareaValue(textarea, next, cursor);
}

function splitRow(line) {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return withoutEdges.split('|').map((cell) => cell.trim());
}

function isSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function normalizeTableBlock(lines) {
  const rows = lines.map(splitRow);
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const normalized = rows.map((row) => {
    const next = [...row];
    while (next.length < columnCount) next.push('');
    return next.slice(0, columnCount);
  });

  const separatorIndex = lines.findIndex(isSeparator);
  if (separatorIndex === -1) {
    normalized.splice(1, 0, Array.from({ length: columnCount }, () => '---'));
  } else {
    normalized[separatorIndex] = normalized[separatorIndex].map((cell) => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      if (left && right) return ':---:';
      if (right) return '---:';
      if (left) return ':---';
      return '---';
    });
  }

  const widths = Array.from({ length: columnCount }, (_, i) =>
    Math.max(
      3,
      ...normalized.map((row) => {
        const cell = row[i] ?? '';
        return cell.replace(/^:?-{3,}:?$/, '---').length;
      }),
    ),
  );

  return normalized
    .map((row) => {
      const cells = row.map((cell, index) => {
        if (/^:?-{3,}:?$/.test(cell)) {
          const left = cell.startsWith(':');
          const right = cell.endsWith(':');
          const width = widths[index];
          if (left && right) return `:${'-'.repeat(Math.max(1, width - 2))}:`;
          if (left) return `:${'-'.repeat(Math.max(2, width - 1))}`;
          if (right) return `${'-'.repeat(Math.max(2, width - 1))}:`;
          return '-'.repeat(width);
        }
        return cell.padEnd(width, ' ');
      });
      return `| ${cells.join(' | ')} |`;
    })
    .join('\n');
}

function findTableRange(value, cursor) {
  const before = value.slice(0, cursor);
  const lineStart = before.lastIndexOf('\n') + 1;
  const lines = value.split('\n');
  let currentLine = value.slice(0, lineStart).split('\n').length - 1;
  if (currentLine >= lines.length) currentLine = lines.length - 1;
  if (!lines[currentLine]?.includes('|')) return null;

  let start = currentLine;
  let end = currentLine;
  while (start > 0 && lines[start - 1].includes('|')) start -= 1;
  while (end < lines.length - 1 && lines[end + 1].includes('|')) end += 1;

  const offsetForLine = (line) => lines.slice(0, line).join('\n').length + (line === 0 ? 0 : 1);
  return {
    startLine: start,
    endLine: end,
    startOffset: offsetForLine(start),
    endOffset: offsetForLine(end) + lines[end].length,
    lines: lines.slice(start, end + 1),
  };
}

export default function activate(ctx) {
  const tracker = createTextareaTracker();
  const runInsert = () => {
    const textarea = tracker.get();
    if (!textarea) {
      void ctx.sdk.ui.alert('Focus a Markdown editor first.', { title: 'Quick Table' });
      return;
    }
    const table = [
      '| Column 1 | Column 2 | Column 3 |',
      '| --- | --- | --- |',
      '|  |  |  |',
      '|  |  |  |',
    ].join('\n');
    insertAtSelection(textarea, table, table.indexOf('Column 1'));
  };

  const insert = ctx.sdk.commands.register({
    id: 'folium.table.insert',
    title: 'Table: insert quick table',
    group: 'Plugins',
    defaultShortcut: 'Mod+Shift+T',
    allowInInput: true,
    run: runInsert,
  });

  const ribbon = ctx.sdk.ribbon.registerAction({
    id: 'folium.table.ribbon',
    title: 'Insert Markdown table',
    icon: 'table',
    order: 20,
    run: runInsert,
  });

  const format = ctx.sdk.commands.register({
    id: 'folium.table.format',
    title: 'Table: format current table',
    group: 'Plugins',
    allowInInput: true,
    run: () => {
      const textarea = tracker.get();
      if (!textarea) {
        void ctx.sdk.ui.alert('Focus a Markdown editor first.', { title: 'Quick Table' });
        return;
      }
      const range = findTableRange(textarea.value, textarea.selectionStart);
      if (!range) {
        void ctx.sdk.ui.alert('Put the cursor inside a Markdown table first.', { title: 'Quick Table' });
        return;
      }
      const formatted = normalizeTableBlock(range.lines);
      const next = `${textarea.value.slice(0, range.startOffset)}${formatted}${textarea.value.slice(range.endOffset)}`;
      setTextareaValue(textarea, next, range.startOffset, range.startOffset + formatted.length);
    },
  });

  return {
    deactivate() {
      tracker.dispose();
      ribbon();
      format();
      insert();
    },
  };
}
