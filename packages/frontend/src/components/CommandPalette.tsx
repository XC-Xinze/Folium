import { useEffect, useMemo, useRef, useState } from 'react';
import { Command as CmdIcon, Search } from 'lucide-react';
import { listCommands, formatShortcut } from '../lib/commands';
import { fuzzyScore } from '../lib/fuzzy';
import { useUIStore } from '../store/uiStore';

/**
 * Obsidian 风命令面板：⌘P 弹，跑任意已注册命令。
 * 跟 QuickSwitcher（⌘K）分开 —— 后者是跳卡片/tag/全文，这里是跑动作。
 */
export function CommandPalette() {
  const open = useUIStore((s) => s.commandPaletteOpen);
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const overrides = useUIStore((s) => s.shortcutOverrides);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 每次打开重置
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const items = useMemo(() => {
    const all = listCommands();
    if (!query.trim()) {
      return all
        .slice()
        .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.title.localeCompare(b.title))
        .slice(0, 30);
    }
    return all
      .map((c) => ({
        cmd: c,
        score: Math.max(fuzzyScore(query, c.title), fuzzyScore(query, c.id), fuzzyScore(query, c.group ?? '')),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30)
      .map((x) => x.cmd);
  }, [query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!open) return null;

  const close = () => setOpen(false);
  const run = (idx: number) => {
    const c = items[idx];
    if (!c) return;
    close();
    // 让 close 先生效再 run，避免命令本身（比如 settings）跟 palette 抢焦点
    requestAnimationFrame(() => {
      try {
        c.run();
      } catch (err) {
        console.error('command failed', c.id, err);
      }
    });
  };

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-start justify-center pt-24 bg-black/30 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="bg-white dark:bg-[#1e2030] rounded-xl shadow-2xl w-[600px] max-w-[92vw] border border-gray-200 dark:border-[#363a4f] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-[#363a4f]">
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
                setActiveIdx((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(activeIdx);
              }
            }}
            placeholder="Run a command…"
            className="flex-1 text-sm outline-none bg-transparent placeholder:text-gray-300"
          />
          <kbd className="text-[10px] font-mono text-gray-400 border border-gray-200 dark:border-[#363a4f] rounded px-1.5 py-0.5">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">No matching commands</div>
          ) : (
            items.map((c, i) => {
              const shortcut = overrides[c.id] ?? c.defaultShortcut;
              return (
                <button
                  key={c.id}
                  data-idx={i}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    run(i);
                  }}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                    i === activeIdx
                      ? 'bg-accentSoft dark:bg-accent/20'
                      : 'hover:bg-gray-50 dark:hover:bg-[#363a4f]/40'
                  }`}
                >
                  <CmdIcon size={11} className="shrink-0 text-gray-400" />
                  <div className="flex-1 min-w-0 flex items-baseline gap-2">
                    {c.group && (
                      <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400 shrink-0">
                        {c.group}
                      </span>
                    )}
                    <span className="text-[13px] truncate">{c.title}</span>
                  </div>
                  {shortcut && (
                    <kbd className="shrink-0 text-[10px] font-mono text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-[#363a4f] rounded px-1.5 py-0.5">
                      {formatShortcut(shortcut)}
                    </kbd>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-gray-100 dark:border-[#363a4f] text-[10px] text-gray-400">
          <span>
            <kbd className="font-mono border border-gray-200 dark:border-[#363a4f] rounded px-1">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono border border-gray-200 dark:border-[#363a4f] rounded px-1">↵</kbd> run
          </span>
          <span className="ml-auto">
            <kbd className="font-mono border border-gray-200 dark:border-[#363a4f] rounded px-1">⌘P</kbd> toggle
          </span>
        </div>
      </div>
    </div>
  );
}
