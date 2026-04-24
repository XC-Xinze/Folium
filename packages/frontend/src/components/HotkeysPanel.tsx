import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { captureShortcut, formatShortcut, listCommands } from '../lib/commands';
import { useUIStore } from '../store/uiStore';

/**
 * Settings 里的快捷键编辑器：列出所有 command，点击当前快捷键进入"录制"模式。
 * Esc 取消、Backspace 清空、其他按键写入覆盖。
 */
export function HotkeysPanel() {
  const overrides = useUIStore((s) => s.shortcutOverrides);
  const setShortcut = useUIStore((s) => s.setShortcut);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Snapshot listCommands once per render so the order is stable
  const commands = listCommands();
  const groups = new Map<string, typeof commands>();
  for (const c of commands) {
    const g = c.group ?? 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(c);
  }

  return (
    <div className="space-y-5">
      {[...groups.entries()].map(([group, cmds]) => (
        <div key={group}>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-2">
            {group}
          </h3>
          <div className="space-y-1">
            {cmds.map((cmd) => {
              const sc = overrides[cmd.id] ?? cmd.defaultShortcut ?? '';
              const isOverridden = !!overrides[cmd.id];
              return (
                <div
                  key={cmd.id}
                  className="flex items-center justify-between gap-3 py-1.5 px-2 rounded hover:bg-gray-50 dark:hover:bg-gray-800/50"
                >
                  <span className="text-[12px]">{cmd.title}</span>
                  <div className="flex items-center gap-1">
                    {editingId === cmd.id ? (
                      <ShortcutCapture
                        onCapture={(s) => {
                          if (s === 'cancel') setEditingId(null);
                          else if (s === 'clear') {
                            setShortcut(cmd.id, null);
                            setEditingId(null);
                          } else {
                            setShortcut(cmd.id, s);
                            setEditingId(null);
                          }
                        }}
                      />
                    ) : (
                      <button
                        onClick={() => setEditingId(cmd.id)}
                        className={`text-[10px] font-mono px-2 py-1 rounded border transition-colors ${
                          sc
                            ? 'border-gray-200 dark:border-gray-700 hover:border-accent dark:hover:border-accent text-ink dark:text-gray-100'
                            : 'border-dashed border-gray-300 dark:border-gray-600 text-gray-400'
                        }`}
                        title="Click to rebind"
                      >
                        {sc ? formatShortcut(sc) : 'Unbound'}
                      </button>
                    )}
                    {isOverridden && (
                      <button
                        onClick={() => setShortcut(cmd.id, null)}
                        className="p-1 text-gray-400 hover:text-accent"
                        title="Reset to default"
                      >
                        <RotateCcw size={11} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <p className="text-[10px] text-gray-400 dark:text-gray-500 pt-2">
        Click a shortcut to rebind. Press Esc to cancel, Backspace to unbind.
      </p>
    </div>
  );
}

function ShortcutCapture({ onCapture }: { onCapture: (s: string | 'cancel' | 'clear') => void }) {
  const inputRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div
      ref={inputRef}
      tabIndex={0}
      onKeyDown={(e) => {
        e.preventDefault();
        const captured = captureShortcut(e.nativeEvent);
        if (captured == null) return; // 单纯按 modifier，等下一次
        onCapture(captured);
      }}
      onBlur={() => onCapture('cancel')}
      className="text-[10px] font-mono px-2 py-1 rounded border border-accent bg-accentSoft dark:bg-accent/20 text-accent outline-none animate-pulse"
    >
      Press keys…
    </div>
  );
}
