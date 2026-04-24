import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Tag } from 'lucide-react';
import { api, type CardSummary } from '../lib/api';
import { fuzzyScore } from '../lib/fuzzy';
import { useNavigateToCard } from '../lib/useNavigateToCard';
import { useUIStore } from '../store/uiStore';

interface Hit {
  kind: 'card' | 'tag';
  /** sort key (higher = better) */
  score: number;
  card?: CardSummary;
  tag?: { name: string; count: number };
}

const MAX_HITS = 30;

export function QuickSwitcher() {
  const open = useUIStore((s) => s.quickSwitcherOpen);
  const setOpen = useUIStore((s) => s.setQuickSwitcherOpen);
  const setFocusTag = useUIStore((s) => s.setFocusTag);
  const navigate = useNavigateToCard();

  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const tagsQ = useQuery({ queryKey: ['tags'], queryFn: api.listTags });

  // 全局快捷键：Cmd+K / Ctrl+K 唤起
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  // 打开时聚焦 + 重置
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
    return [...cardHits, ...tagHits]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_HITS);
  }, [query, cardsQ.data, tagsQ.data]);

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

  const acceptHit = (hit: Hit) => {
    if (hit.kind === 'card' && hit.card) {
      navigate(hit.card.luhmannId);
    } else if (hit.kind === 'tag' && hit.tag) {
      setFocusTag(hit.tag.name);
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
                if (hit) acceptHit(hit);
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
            hits.map((h, i) => (
              <button
                key={h.kind === 'card' ? `c:${h.card!.luhmannId}` : `t:${h.tag!.name}`}
                data-idx={i}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptHit(h);
                }}
                onMouseEnter={() => setActiveIdx(i)}
                className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
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
                      <span
                        key={t}
                        className="shrink-0 text-[9px] font-bold text-gray-400"
                      >
                        #{t}
                      </span>
                    ))}
                  </>
                ) : (
                  <>
                    <Tag size={12} className="shrink-0 text-accent" />
                    <span className="flex-1 text-[13px] font-bold">#{h.tag!.name}</span>
                    <span className="shrink-0 text-[10px] text-gray-400">
                      {h.tag!.count} cards
                    </span>
                  </>
                )}
              </button>
            ))
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
