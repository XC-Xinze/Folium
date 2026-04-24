import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Play, Search } from 'lucide-react';
import { api } from '../lib/api';
import { dialog } from '../lib/dialog';

interface Change {
  luhmannId: string;
  title: string;
  count: number;
  preview: string;
}

export function SearchReplacePanel() {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [bodyOnly, setBodyOnly] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<{ changes: Change[]; total: number } | null>(null);

  const runPreview = async () => {
    if (!query) return;
    setPreviewing(true);
    setPreview(null);
    try {
      const r = await api.searchReplace({
        query,
        replacement,
        useRegex,
        caseSensitive,
        bodyOnly,
        dryRun: true,
      });
      setPreview({ changes: r.changes, total: r.totalCount });
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Preview failed' });
    } finally {
      setPreviewing(false);
    }
  };

  const applyChanges = async () => {
    if (!preview || preview.total === 0) return;
    const ok = await dialog.confirm(
      `Replace ${preview.total} occurrence${preview.total === 1 ? '' : 's'} across ${preview.changes.length} card${
        preview.changes.length === 1 ? '' : 's'
      }?`,
      {
        title: 'Apply replace',
        description: 'This rewrites the .md files. There is no undo other than git.',
        confirmLabel: 'Replace',
        variant: 'danger',
      },
    );
    if (!ok) return;
    setApplying(true);
    try {
      const r = await api.searchReplace({
        query,
        replacement,
        useRegex,
        caseSensitive,
        bodyOnly,
        dryRun: false,
      });
      // 全部失效，让所有视图重新拉
      qc.invalidateQueries();
      setPreview({ changes: r.changes, total: r.totalCount });
      await dialog.alert(`Replaced in ${r.filesUpdated} file${r.filesUpdated === 1 ? '' : 's'}.`, {
        title: 'Done',
      });
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Replace failed' });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPreview(null);
          }}
          placeholder="Find…"
          className="text-[12px] px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 outline-none focus:border-accent"
        />
        <input
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
          placeholder="Replace with…"
          className="text-[12px] px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 outline-none focus:border-accent"
        />
      </div>
      <div className="flex flex-wrap gap-3 text-[11px]">
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={useRegex}
            onChange={(e) => {
              setUseRegex(e.target.checked);
              setPreview(null);
            }}
          />
          <span>Regex</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => {
              setCaseSensitive(e.target.checked);
              setPreview(null);
            }}
          />
          <span>Case sensitive</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={bodyOnly}
            onChange={(e) => {
              setBodyOnly(e.target.checked);
              setPreview(null);
            }}
          />
          <span>Body only (skip frontmatter)</span>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={runPreview}
          disabled={!query || previewing}
          className="text-[11px] font-bold flex items-center gap-1.5 px-3 py-1.5 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40"
        >
          <Search size={11} />
          {previewing ? 'Searching…' : 'Preview'}
        </button>
        <button
          onClick={applyChanges}
          disabled={!preview || preview.total === 0 || applying}
          className="text-[11px] font-bold flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40"
        >
          <Play size={11} />
          {applying ? 'Applying…' : `Replace${preview ? ` (${preview.total})` : ''}`}
        </button>
      </div>
      {preview && (
        <div className="border border-gray-200 dark:border-gray-700 rounded p-3 max-h-72 overflow-y-auto">
          {preview.changes.length === 0 ? (
            <p className="text-[11px] text-gray-400 italic">No matches.</p>
          ) : (
            <>
              <div className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 mb-2">
                <AlertTriangle size={11} />
                <span>
                  {preview.total} occurrence{preview.total === 1 ? '' : 's'} in {preview.changes.length} card
                  {preview.changes.length === 1 ? '' : 's'}
                </span>
              </div>
              <ul className="space-y-1.5">
                {preview.changes.slice(0, 100).map((c) => (
                  <li key={c.luhmannId} className="text-[11px]">
                    <div className="flex items-baseline gap-2">
                      <code className="font-mono text-[10px] text-accent">{c.luhmannId}</code>
                      <span className="text-gray-700 dark:text-gray-300 truncate">{c.title}</span>
                      <span className="ml-auto text-gray-400">×{c.count}</span>
                    </div>
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 font-mono truncate pl-2">
                      {c.preview}
                    </div>
                  </li>
                ))}
                {preview.changes.length > 100 && (
                  <li className="text-[10px] text-gray-400">+ {preview.changes.length - 100} more cards</li>
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
