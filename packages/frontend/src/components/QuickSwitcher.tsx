import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Search, Tag } from 'lucide-react';
import { api, type CardSummary } from '../lib/api';
import { fuzzyScore } from '../lib/fuzzy';
import { useNavigateToCard } from '../lib/useNavigateToCard';
import { useUIStore } from '../store/uiStore';
import { usePaneStore } from '../store/paneStore';

interface Hit {
  kind: 'card' | 'tag' | 'content';
  /** sort key (higher = better) */
  score: number;
  card?: CardSummary;
  tag?: { name: string; count: number };
  /** content 命中：snippet 已经带 ⟨高亮⟩ 标记 */
  content?: { luhmannId: string; title: string; snippet: string };
}

const MAX_HITS = 30;

/** FTS5 snippet 用 ⟨⟩ 包裹命中词 → HTML <mark>，注意先 escape XSS */
function highlightSnippet(s: string): string {
  const escaped = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/⟨/g, '<mark class="bg-yellow-200 dark:bg-yellow-600/40 text-inherit">')
    .replace(/⟩/g, '</mark>');
}

export function QuickSwitcher() {
  const open = useUIStore((s) => s.quickSwitcherOpen);
  const setOpen = useUIStore((s) => s.setQuickSwitcherOpen);
  const openPaneTab = usePaneStore((s) => s.openTab);
  const navigate = useNavigateToCard();

  const [query, setQuery] = useState('');
  // FTS 搜索 debounce 到 200ms，避免每个按键都打后端
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(t);
  }, [query]);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const tagsQ = useQuery({ queryKey: ['tags'], queryFn: api.listTags });
  // FTS 内容搜索：用 debounced query，避免每个按键都打后端
  const searchQ = useQuery({
    queryKey: ['search', debouncedQuery],
    queryFn: () => api.search(debouncedQuery, 15),
    enabled: open && debouncedQuery.trim().length >= 2,
  });

  // 打开时聚焦 + 重置（全局 Cmd+K 由 lib/commands 统一管理）
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const hits = useMemo<Hit[]>(() => {
    if (!query.trim()) {
      // 空查询：列出最近 / 高频卡片（这里简单按 sortKey 排前 30）
      const topCards = (cardsQ.data?.cards ?? [])
        .slice()
        .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
        .slice(0, MAX_HITS);
      return topCards.map<Hit>((c) => ({ kind: 'card', score: 0, card: c }));
    }
    const q = query.trim();
    const cardHits: Hit[] = [];
    for (const c of cardsQ.data?.cards ?? []) {
      const idScore = fuzzyScore(q, c.luhmannId);
      const titleScore = fuzzyScore(q, c.title);
      const tagsScore = Math.max(0, ...c.tags.map((t) => fuzzyScore(q, t)));
      const score = Math.max(idScore, titleScore, tagsScore * 0.7);
      if (score > 0) cardHits.push({ kind: 'card', score, card: c });
    }
    const tagHits: Hit[] = [];
    for (const t of tagsQ.data?.tags ?? []) {
      const score = fuzzyScore(q, t.name);
      if (score > 0) tagHits.push({ kind: 'tag', score, tag: t });
    }
    // 内容命中（FTS5）：去重 —— 已经在 cardHits 里的 luhmannId 不再重复列出
    const cardIdsAlreadyShown = new Set(cardHits.map((h) => h.card!.luhmannId));
    const contentHits: Hit[] = [];
    for (const h of searchQ.data?.hits ?? []) {
      if (cardIdsAlreadyShown.has(h.luhmannId)) continue;
      contentHits.push({
        kind: 'content',
        // FTS rank 越小越好，做归一化让它跟 fuzzy 在一个量级（fuzzy 最高 1000）
        score: 100,
        content: h,
      });
    }
    return [
      ...cardHits.sort((a, b) => b.score - a.score),
      ...tagHits.sort((a, b) => b.score - a.score),
      ...contentHits, // 内容命中放最后，FTS 已经按相关性排过
    ].slice(0, MAX_HITS);
  }, [query, cardsQ.data, tagsQ.data, searchQ.data]);

  // query 变化时重置选中索引
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // 滚动跟随
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!open) return null;

  const close = () => setOpen(false);

  const acceptHit = (
    hit: Hit,
    opts?: { newTab?: boolean; splitDirection?: 'horizontal' | 'vertical' },
  ) => {
    if (hit.kind === 'card' && hit.card) {
      navigate(hit.card.luhmannId, opts);
    } else if (hit.kind === 'tag' && hit.tag) {
      openPaneTab({ kind: 'tag', title: `#${hit.tag.name}`, tagName: hit.tag.name }, opts);
    } else if (hit.kind === 'content' && hit.content) {
      navigate(hit.content.luhmannId, opts);
    }
    close();
  };

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-start justify-center pt-24 bg-black/30 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-[600px] max-w-[92vw] border border-gray-200 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
          <Search size={16} className="text-gray-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                close();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIdx((i) => Math.min(i + 1, hits.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const hit = hits[activeIdx];
                if (!hit) return;
                const cmd = e.metaKey || e.ctrlKey;
                if (cmd && e.shiftKey) acceptHit(hit, { splitDirection: 'horizontal' });
                else if (cmd) acceptHit(hit, { newTab: true });
                else acceptHit(hit);
              }
            }}
            placeholder="Jump to a card by id, title, or tag…"
            className="flex-1 text-sm outline-none placeholder:text-gray-300"
          />
          <kbd className="text-[10px] font-mono text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto">
          {hits.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              No matches
            </div>
          ) : (
            hits.map((h, i) => {
              const key =
                h.kind === 'card'
                  ? `c:${h.card!.luhmannId}`
                  : h.kind === 'tag'
                    ? `t:${h.tag!.name}`
                    : `f:${h.content!.luhmannId}`;
              return (
                <button
                  key={key}
                  data-idx={i}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const cmd = e.metaKey || e.ctrlKey;
                    if (cmd && e.shiftKey) acceptHit(h, { splitDirection: 'horizontal' });
                    else if (cmd) acceptHit(h, { newTab: true });
                    else acceptHit(h);
                  }}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={`w-full flex items-start gap-3 px-4 py-2 text-left transition-colors ${
                    i === activeIdx ? 'bg-accentSoft' : 'hover:bg-gray-50'
                  }`}
                >
                  {h.kind === 'card' ? (
                    <>
                      <span
                        className={`shrink-0 font-mono text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          h.card!.status === 'INDEX'
                            ? 'bg-accent text-white'
                            : 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {h.card!.luhmannId}
                      </span>
                      <span className="flex-1 text-[13px] truncate">
                        {h.card!.title || h.card!.luhmannId}
                      </span>
                      {h.card!.tags.slice(0, 3).map((t) => (
                        <span key={t} className="shrink-0 text-[9px] font-bold text-gray-400">
                          #{t}
                        </span>
                      ))}
                    </>
                  ) : h.kind === 'tag' ? (
                    <>
                      <Tag size={12} className="shrink-0 text-accent mt-1" />
                      <span className="flex-1 text-[13px] font-bold">#{h.tag!.name}</span>
                      <span className="shrink-0 text-[10px] text-gray-400">
                        {h.tag!.count} cards
                      </span>
                    </>
                  ) : (
                    /* content match: 全文搜索命中 */
                    <>
                      <FileText size={12} className="shrink-0 text-gray-400 mt-1" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] font-bold text-gray-500">
                            {h.content!.luhmannId}
                          </span>
                          <span className="text-[12px] truncate">
                            {h.content!.title || h.content!.luhmannId}
                          </span>
                        </div>
                        <div
                          className="text-[11px] text-gray-500 mt-0.5 truncate"
                          dangerouslySetInnerHTML={{
                            __html: highlightSnippet(h.content!.snippet),
                          }}
                        />
                      </div>
                    </>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-gray-100 text-[10px] text-gray-400">
          <span>
            <kbd className="font-mono border border-gray-200 rounded px-1">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono border border-gray-200 rounded px-1">↵</kbd> open
          </span>
          <span className="ml-auto">
            <kbd className="font-mono border border-gray-200 rounded px-1">⌘K</kbd> toggle
          </span>
        </div>
      </div>
    </div>
  );
}
