import { useEffect, useRef } from 'react';
import { ChevronsRight, Copy, MoveRight, SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react';
import type { LeafPane } from '../store/paneStore';
import { usePaneStore } from '../store/paneStore';

interface Props {
  pane: LeafPane;
  tabId: string;
  /** 屏幕坐标 */
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * 右键 tab 弹出的菜单。Obsidian/Chrome 风的常用动作。
 * 点外面或 Esc 自动关。
 */
export function TabContextMenu({ pane, tabId, x, y, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const closeTab = usePaneStore((s) => s.closeTab);
  const splitPane = usePaneStore((s) => s.splitPane);
  const moveTabToSplit = usePaneStore((s) => s.moveTabToSplit);

  const idx = pane.tabs.findIndex((t) => t.id === tabId);
  const onlyOne = pane.tabs.length === 1;
  const hasRight = idx >= 0 && idx < pane.tabs.length - 1;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // clamp 到视口内
  const W = 220;
  const H = 280;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);

  const items: Array<
    | { kind: 'item'; icon: typeof X; label: string; disabled?: boolean; onClick: () => void }
    | { kind: 'separator' }
  > = [
    {
      kind: 'item',
      icon: X,
      label: 'Close',
      onClick: () => {
        closeTab(pane.id, tabId);
        onClose();
      },
    },
    {
      kind: 'item',
      icon: Copy,
      label: 'Close others',
      disabled: onlyOne,
      onClick: () => {
        for (const t of pane.tabs) {
          if (t.id !== tabId) closeTab(pane.id, t.id);
        }
        onClose();
      },
    },
    {
      kind: 'item',
      icon: ChevronsRight,
      label: 'Close to the right',
      disabled: !hasRight,
      onClick: () => {
        for (const t of pane.tabs.slice(idx + 1)) closeTab(pane.id, t.id);
        onClose();
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      icon: SplitSquareHorizontal,
      label: 'Split right (move tab)',
      onClick: () => {
        moveTabToSplit(pane.id, tabId, pane.id, 'right');
        onClose();
      },
    },
    {
      kind: 'item',
      icon: SplitSquareVertical,
      label: 'Split down (move tab)',
      onClick: () => {
        moveTabToSplit(pane.id, tabId, pane.id, 'bottom');
        onClose();
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      icon: MoveRight,
      label: 'Split this pane right',
      onClick: () => {
        splitPane(pane.id, 'horizontal');
        onClose();
      },
    },
  ];

  return (
    <div
      ref={ref}
      className="fixed z-[1300] bg-white dark:bg-[#1e2030] border border-gray-200 dark:border-[#363a4f] rounded-lg shadow-2xl py-1 min-w-[220px]"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.kind === 'separator' ? (
          <div key={i} className="my-1 border-t border-gray-100 dark:border-[#363a4f]" />
        ) : (
          <button
            key={i}
            disabled={it.disabled}
            onClick={it.onClick}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-gray-50 dark:hover:bg-[#363a4f]/40 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <it.icon size={12} className="text-gray-500 dark:text-gray-400 shrink-0" />
            <span className="flex-1 truncate">{it.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
