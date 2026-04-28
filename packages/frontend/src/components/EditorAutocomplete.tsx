import { useEffect, useRef } from 'react';
import { FileText, Hash, Link2 } from 'lucide-react';
import type { TriggerKind } from '../lib/editorAutocomplete';

export interface AutocompleteItem {
  /** 显示用 */
  label: string;
  /** 副信息（id / 卡数等） */
  hint?: string;
  /** 实际插入的字符串（不含 [[ / # 等包装） */
  value: string;
}

interface Props {
  open: boolean;
  kind: TriggerKind | null;
  items: AutocompleteItem[];
  activeIdx: number;
  setActiveIdx: (i: number) => void;
  onAccept: (item: AutocompleteItem) => void;
  /** 锚点：相对屏幕（fixed 定位） */
  anchorRect: { top: number; left: number; bottom: number } | null;
}

const ICON: Record<TriggerKind, typeof Link2> = {
  wikilink: Link2,
  transclusion: FileText,
  tag: Hash,
};

const KIND_LABEL: Record<TriggerKind, string> = {
  wikilink: '[[link]]',
  transclusion: '![[embed]]',
  tag: '#tag',
};

export function EditorAutocomplete({
  open,
  kind,
  items,
  activeIdx,
  setActiveIdx,
  onAccept,
  anchorRect,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // 选中项滚动跟随
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!open || !kind || !anchorRect || items.length === 0) return null;

  const Icon = ICON[kind];

  // 简单定位策略：贴在光标行下方；若离屏底太近则放上面
  const VIEWPORT_H = window.innerHeight;
  const VIEWPORT_W = window.innerWidth;
  const POPUP_W = Math.min(320, VIEWPORT_W - 16);
  const POPUP_H_EST = Math.min(280, items.length * 36 + 32);
  const placeAbove = anchorRect.bottom + POPUP_H_EST + 8 > VIEWPORT_H;
  const top = placeAbove ? Math.max(8, anchorRect.top - POPUP_H_EST - 4) : anchorRect.bottom + 4;
  // 不让 left 把面板挤出右边
  const left = Math.min(anchorRect.left, VIEWPORT_W - POPUP_W - 8);

  return (
    <div
      className="fixed z-[1200] bg-white dark:bg-[#363a4f] border border-gray-200 dark:border-[#494d64] rounded-lg shadow-2xl overflow-hidden"
      style={{
        top,
        left: Math.max(8, left),
        width: POPUP_W,
        maxHeight: POPUP_H_EST,
      }}
      onMouseDown={(e) => e.preventDefault() /* 不要让 textarea 失焦 */}
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 dark:bg-[#494d64] text-[10px] font-bold uppercase tracking-widest text-gray-500 dark:text-[#a5adcb] border-b border-gray-100 dark:border-[#5b6078]">
        <Icon size={11} />
        <span>{KIND_LABEL[kind]}</span>
        <span className="ml-auto font-normal normal-case tracking-normal text-gray-400">
          ↑↓ Enter
        </span>
      </div>
      <div ref={listRef} className="overflow-y-auto" style={{ maxHeight: POPUP_H_EST - 28 }}>
        {items.map((it, i) => (
          <button
            key={it.value + i}
            data-idx={i}
            onClick={() => onAccept(it)}
            onMouseEnter={() => setActiveIdx(i)}
            className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 transition-colors ${
              i === activeIdx
                ? 'bg-accentSoft dark:bg-[#a7c7a1]/15'
                : 'hover:bg-gray-50 dark:hover:bg-[#494d64]/40'
            }`}
          >
            <span className="font-mono text-[10px] font-bold text-accent dark:text-[#a7c7a1] shrink-0 truncate max-w-[80px]">
              {it.value}
            </span>
            <span className="text-[12px] truncate flex-1 text-gray-700 dark:text-[#cad3f5]">
              {it.label}
            </span>
            {it.hint && (
              <span className="text-[10px] text-gray-400 shrink-0">{it.hint}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
