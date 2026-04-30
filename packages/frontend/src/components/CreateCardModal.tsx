import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import { NewCardBar } from './NewCardBar';

/**
 * Obsidian 风：新建卡片走模态弹窗，主区不再常驻输入框。
 * 触发：⌘N / RibbonBar + 按钮 / sidebar 入口。
 */
export function CreateCardModal() {
  const open = useUIStore((s) => s.newCardOpen);
  const setOpen = useUIStore((s) => s.setNewCardOpen);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-start justify-center pt-16 px-6 bg-[#1c1b1b]/35 dark:bg-black/50 backdrop-blur-[3px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="zk-paper-surface rounded-xl w-full max-w-3xl flex flex-col overflow-hidden border border-paperEdge">
        <header className="flex items-center justify-between px-5 py-3 border-b border-paperEdge/80 shrink-0 bg-gradient-to-b from-white/45 to-transparent dark:from-white/5">
          <div className="min-w-0">
            <h1 className="font-display text-[22px] leading-tight font-semibold text-ink">
              New card
            </h1>
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted mt-0.5">
              Folium
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="p-1.5 rounded-md hover:bg-surfaceAlt text-muted hover:text-ink transition-colors"
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </header>
        <NewCardBar variant="modal" onCreated={() => setOpen(false)} />
      </div>
    </div>
  );
}
