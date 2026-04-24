import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRightToLine, Link2 } from 'lucide-react';
import { api } from '../lib/api';
import { useNavigateToCard } from '../lib/useNavigateToCard';

/**
 * 浮在画布右上的"被谁链接了"小气泡。
 * 数据源是后端 getReferencedFrom：扫所有卡的 crossLinks 找 source，附带引用所在段落。
 * 不包含"未链接提及"——那个在 canvas 上已经以 potential 形式可视化了，避免重复。
 */
export function BacklinksPopover({ focusedCardId }: { focusedCardId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigateToCard();

  const q = useQuery({
    queryKey: ['referenced-from', focusedCardId],
    queryFn: () => api.getReferencedFrom(focusedCardId),
    enabled: !!focusedCardId,
  });

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const hits = q.data?.hits ?? [];
  const count = hits.length;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={!focusedCardId}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full shadow-md border transition-all text-[10px] font-bold uppercase tracking-widest ${
          count > 0
            ? open
              ? 'bg-accent text-white border-accent'
              : 'bg-white border-gray-200 text-gray-700 hover:border-accent/40'
            : 'bg-white border-gray-200 text-gray-300'
        }`}
        title={count > 0 ? `${count} cards link to this one` : 'No backlinks'}
      >
        <Link2 size={11} />
        <span>Backlinks</span>
        <span
          className={`text-[10px] tabular-nums px-1 rounded ${
            count > 0
              ? open
                ? 'bg-white/20 text-white'
                : 'bg-gray-100 text-gray-600'
              : 'text-gray-300'
          }`}
        >
          {count}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-[420px] max-h-[60vh] bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden z-20">
          <div className="px-3 py-2 border-b border-gray-100 text-[10px] font-black uppercase tracking-widest text-gray-400 bg-gray-50">
            Linked references · {count}
          </div>
          <div className="max-h-[55vh] overflow-y-auto">
            {q.isLoading ? (
              <div className="px-4 py-6 text-center text-sm text-gray-400">Loading…</div>
            ) : count === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-gray-400">
                No card links to <span className="font-mono">{focusedCardId}</span> yet.
              </div>
            ) : (
              hits.map((h) => (
                <button
                  key={h.sourceId}
                  onClick={() => {
                    navigate(h.sourceId);
                    setOpen(false);
                  }}
                  className="w-full flex flex-col gap-1 px-3 py-2 border-b border-gray-50 text-left hover:bg-accentSoft/40 transition-colors group"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 group-hover:bg-accent group-hover:text-white">
                      {h.sourceId}
                    </span>
                    <span className="text-[12px] font-semibold truncate">{h.sourceTitle}</span>
                    <ArrowRightToLine
                      size={11}
                      className="ml-auto text-gray-300 group-hover:text-accent shrink-0"
                    />
                  </div>
                  {h.paragraph && (
                    <p className="text-[11px] text-gray-500 leading-relaxed line-clamp-3 pl-1 border-l-2 border-gray-200 group-hover:border-accent">
                      {h.paragraph}
                    </p>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
