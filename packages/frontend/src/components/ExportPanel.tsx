import { Download, FileDown, FolderArchive } from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fuzzyScore } from '../lib/fuzzy';

export function ExportPanel() {
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const filtered = (cardsQ.data?.cards ?? [])
    .map((c) => ({
      c,
      score: filter
        ? Math.max(fuzzyScore(filter, c.luhmannId), fuzzyScore(filter, c.title))
        : 0,
    }))
    .filter((x) => !filter || x.score > 0)
    .sort((a, b) => (filter ? b.score - a.score : a.c.sortKey.localeCompare(b.c.sortKey)))
    .slice(0, 20)
    .map((x) => x.c);

  const download = async (url: string, fallbackName: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = disposition.match(/filename="([^"]+)"/i);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = match?.[1] ?? fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-4">
      <div>
        <button
          type="button"
          onClick={() => void download(api.exportVaultUrl(), 'vault.zip')}
          className="inline-flex items-center gap-2 text-[12px] font-bold px-3 py-2 rounded bg-accent text-white hover:bg-accent/90"
        >
          <FolderArchive size={13} />
          Export entire vault (.zip)
        </button>
        <p className="text-[10px] text-gray-400 mt-1">
          Bundles every .md plus the attachments/ directory.
        </p>
      </div>

      <div className="border-t border-gray-100 dark:border-gray-700 pt-3">
        <div className="text-[11px] font-bold mb-2">Export single card or subtree</div>
        <input
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPicked(null);
          }}
          placeholder="Search cards by id or title…"
          className="w-full text-[12px] px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 outline-none focus:border-accent"
        />
        {filter && (
          <ul className="mt-2 max-h-48 overflow-y-auto border border-gray-100 dark:border-gray-700 rounded">
            {filtered.length === 0 ? (
              <li className="text-[11px] text-gray-400 px-2 py-1.5">No matches.</li>
            ) : (
              filtered.map((c) => (
                <li key={c.luhmannId}>
                  <button
                    onClick={() => setPicked(c.luhmannId)}
                    className={`w-full flex items-baseline gap-2 px-2 py-1 text-left text-[11px] ${
                      picked === c.luhmannId
                        ? 'bg-accentSoft'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                  >
                    <code className="font-mono text-[10px] text-accent shrink-0">{c.luhmannId}</code>
                    <span className="truncate">{c.title}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
        {picked && (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void download(api.exportCardUrl(picked), `${picked}.md`)}
              className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <FileDown size={11} />
              Card .md
            </button>
            <button
              type="button"
              onClick={() => void download(api.exportSubtreeUrl(picked), `vault-subtree-${picked}.zip`)}
              className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <Download size={11} />
              Subtree .zip
            </button>
            <code className="ml-2 text-[10px] text-gray-500">{picked}</code>
          </div>
        )}
      </div>
    </div>
  );
}
