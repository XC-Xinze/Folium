import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { BookOpen, CalendarDays, LayoutGrid, Rows3, Search } from 'lucide-react';
import { api, type Card, type CardSummary } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { usePaneStore } from '../store/paneStore';
import { t } from '../lib/i18n';
import { useUIStore } from '../store/uiStore';

const MAX_FULL_PREVIEWS = 240;
type MasonryMode = 'rich' | 'quiet';

export function CardMasonryView() {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<MasonryMode>(() => {
    const stored = window.localStorage.getItem('folium-masonry-mode');
    return stored === 'quiet' ? 'quiet' : 'rich';
  });
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [showDaily, setShowDaily] = useState(false);
  const language = useUIStore((s) => s.language);
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const summaries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cards = [...(cardsQ.data?.cards ?? [])]
      .filter((card) => showDaily || !/^daily\d{8}$/i.test(card.luhmannId))
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    if (!q) return cards;
    const terms = q.split(/\s+/).filter(Boolean);
    return cards.filter((c) => {
      const id = c.luhmannId.toLowerCase();
      const title = c.title.toLowerCase();
      const tags = c.tags.map((tag) => tag.toLowerCase());
      const links = c.crossLinks.map((link) => link.toLowerCase());
      return terms.every((term) => {
        if (term.startsWith('#')) {
          const tagTerm = term.slice(1);
          return !!tagTerm && tags.some((tag) => tag.includes(tagTerm));
        }
        return (
          id.includes(term) ||
          title.includes(term) ||
          tags.some((tag) => tag.includes(term)) ||
          links.some((link) => link.includes(term))
        );
      });
    });
  }, [cardsQ.data, query, showDaily]);
  const previewIds = summaries.slice(0, MAX_FULL_PREVIEWS).map((c) => c.luhmannId);
  const fullQs = useQueries({
    queries: previewIds.map((id) => ({
      queryKey: ['card', id],
      queryFn: () => api.getCard(id),
      staleTime: 30_000,
    })),
  });
  const fullById = new Map<string, Card>();
  fullQs.forEach((q, i) => {
    if (q.data) fullById.set(previewIds[i]!, q.data);
  });
  const setMasonryMode = (next: MasonryMode) => {
    setMode(next);
    window.localStorage.setItem('folium-masonry-mode', next);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface dark:bg-[#24273a]">
      <main className="mx-auto w-full max-w-[1500px] px-6 py-6">
        <header className="mb-5 flex items-end justify-between gap-4 border-b border-paperEdge pb-4">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-muted">{t('masonry.scope', {}, language)}</div>
            <h1 className="font-display text-[32px] leading-tight font-semibold text-ink">{t('masonry.title', {}, language)}</h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="zk-toolbar-surface flex items-center gap-1 rounded-full border p-1">
              {([
                ['rich', <LayoutGrid key="rich" size={13} />, t('masonry.rich', {}, language)],
                ['quiet', <Rows3 key="quiet" size={13} />, t('masonry.quiet', {}, language)],
              ] as Array<[MasonryMode, JSX.Element, string]>).map(([value, icon, label]) => (
                <button
                  key={value}
                  onClick={() => setMasonryMode(value)}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition-colors ${
                    mode === value
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-muted hover:bg-surfaceAlt hover:text-ink'
                  }`}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
            <label className="zk-toolbar-surface flex items-center gap-2 rounded-full border px-3 py-2 w-72">
              <Search size={14} className="text-muted shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-0 flex-1 bg-transparent outline-none text-[13px] text-ink placeholder:text-muted"
                placeholder={t('masonry.filter', {}, language)}
              />
            </label>
            <button
              type="button"
              onClick={() => setShowDaily((value) => !value)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-[11px] font-bold transition-colors ${
                showDaily
                  ? 'border-accent bg-accent text-white shadow-sm hover:bg-accent/90'
                  : 'zk-toolbar-surface text-muted hover:bg-surfaceAlt hover:text-ink'
              }`}
              title={t('masonry.dailyNotes', {}, language)}
            >
              <CalendarDays size={13} />
              {t('masonry.dailyNotes', {}, language)}
            </button>
          </div>
        </header>

        <section className={mode === 'quiet'
          ? 'mx-auto flex max-w-[900px] flex-col gap-3'
          : 'columns-1 gap-4 sm:columns-2 xl:columns-3 2xl:columns-4 [column-fill:_balance]'
        }>
          {summaries.map((summary) => (
            <MasonryCard
              key={summary.luhmannId}
              summary={summary}
              full={fullById.get(summary.luhmannId)}
              mode={mode}
              expanded={expandedIds.has(summary.luhmannId)}
              onToggleExpanded={() => {
                setExpandedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(summary.luhmannId)) next.delete(summary.luhmannId);
                  else next.add(summary.luhmannId);
                  return next;
                });
              }}
            />
          ))}
        </section>
        {summaries.length > MAX_FULL_PREVIEWS && (
          <div className="mt-6 text-center text-[11px] text-muted">
            {t('masonry.previewLimit', { count: MAX_FULL_PREVIEWS }, language)}
          </div>
        )}
      </main>
    </div>
  );
}

function MasonryCard({
  summary,
  full,
  mode,
  expanded,
  onToggleExpanded,
}: {
  summary: CardSummary;
  full?: Card;
  mode: MasonryMode;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const openTab = usePaneStore((s) => s.openTab);
  const language = useUIStore((s) => s.language);
  const content = full?.contentMd ?? '';
  const limit = mode === 'quiet' ? 420 : 900;
  const canExpand = content.length > limit;
  const visibleContent = canExpand && !expanded ? `${content.slice(0, limit)}\n\n...` : content;
  const html = visibleContent ? renderMarkdown(visibleContent) : '';
  const openPage = () => {
    openTab({
      kind: 'page',
      title: summary.title || summary.luhmannId,
      pageCardId: summary.luhmannId,
    });
  };

  return (
    <article className="mb-4 break-inside-avoid overflow-hidden transition-colors zk-paper-surface border border-paperEdge rounded-lg hover:border-accent/35">
      <button onClick={openPage} className="w-full text-left block px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-surfaceAlt text-accent">
              {summary.luhmannId}
            </span>
            <h2 className="mt-2 text-[19px] font-display leading-tight font-semibold text-ink">
              {summary.title || summary.luhmannId}
            </h2>
          </div>
          <BookOpen size={15} className="text-muted mt-1 shrink-0" />
        </div>
      </button>
      {html ? (
        <div
          className={`prose-card text-[12px] text-ink/90 overflow-hidden ${
            expanded ? 'px-4 pb-3 max-h-none' : mode === 'quiet' ? 'px-4 pb-3 max-h-[260px]' : 'px-4 pb-3 max-h-[360px]'
          }`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="px-4 pb-3 text-[11px] text-muted italic">{t('masonry.loadingPreview', {}, language)}</div>
      )}
      {canExpand && (
        <div className="px-4 pb-3">
          <button
            type="button"
            onClick={onToggleExpanded}
            className="rounded-full border border-paperEdge px-2.5 py-1 text-[10px] font-bold text-muted transition-colors hover:border-accent/40 hover:bg-accentSoft hover:text-accent"
          >
            {expanded ? t('masonry.collapse', {}, language) : t('masonry.expand', {}, language)}
          </button>
        </div>
      )}
      {(summary.tags.length > 0 || summary.crossLinks.length > 0) && (
        <footer className="border-t border-paperEdge/70 px-4 py-2 flex items-center gap-2 flex-wrap text-[10px]">
          {summary.tags.slice(0, 5).map((tag) => (
            <span key={tag} className="font-bold text-accent">
              #{tag}
            </span>
          ))}
          {summary.crossLinks.length > 0 && (
            <span className="text-muted tabular-nums">→ {summary.crossLinks.length}</span>
          )}
        </footer>
      )}
    </article>
  );
}
