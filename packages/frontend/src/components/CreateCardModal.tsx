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
      className="fixed inset-0 z-[1100] flex items-start justify-center pt-24 px-6 bg-black/40 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="bg-white dark:bg-[#1e2030] rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden border border-gray-200 dark:border-[#363a4f]">
        <header className="flex items-center justify-between px-4 py-2 border-b border-gray-100 dark:border-[#363a4f] shrink-0">
          <h1 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            New card
          </h1>
          <button
            onClick={() => setOpen(false)}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-[#363a4f] text-gray-500"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </header>
        <NewCardBar onCreated={() => setOpen(false)} />
      </div>
    </div>
  );
}
