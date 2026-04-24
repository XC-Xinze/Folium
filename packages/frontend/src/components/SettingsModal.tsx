import { lazy, Suspense, useEffect } from 'react';
import { X } from 'lucide-react';
import { useUIStore } from '../store/uiStore';

const SettingsView = lazy(() =>
  import('./SettingsView').then((m) => ({ default: m.SettingsView })),
);

/**
 * Obsidian 风：设置以模态弹窗形式打开（不占用 pane 空间）。
 * - Esc / 点 backdrop / X 都能关
 * - 内容用 lazy 加载（与 tab 模式一致，不重复打主 bundle）
 */
export function SettingsModal() {
  const open = useUIStore((s) => s.settingsOpen);
  const setOpen = useUIStore((s) => s.setSettingsOpen);

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
      className="fixed inset-0 z-[1100] flex items-center justify-center p-6 bg-black/40 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="bg-white dark:bg-[#1e2030] rounded-2xl shadow-2xl w-full max-w-3xl h-[80vh] max-h-[860px] flex flex-col overflow-hidden border border-gray-200 dark:border-[#363a4f]">
        <header className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-[#363a4f] shrink-0">
          <h1 className="text-sm font-bold">Settings</h1>
          <button
            onClick={() => setOpen(false)}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-[#363a4f] text-gray-500"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">
          <Suspense
            fallback={
              <div className="p-10 text-sm text-gray-400">Loading settings…</div>
            }
          >
            <SettingsView />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
