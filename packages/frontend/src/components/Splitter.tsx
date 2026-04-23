import { useCallback, type RefObject } from 'react';
import type { WorkspacePanelPosition } from '../store/uiStore';

/**
 * 主区与 workspace 面板之间的可拖动分隔条。
 * 拖动时实时计算 workspace 占容器的百分比并回调。
 */
export function Splitter({
  position,
  containerRef,
  onSizeChange,
}: {
  position: WorkspacePanelPosition;
  containerRef: RefObject<HTMLDivElement>;
  onSizeChange: (percent: number) => void;
}) {
  const isHorizontal = position === 'left' || position === 'right';

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const prevSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';

      const onMove = (ev: MouseEvent) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        let percent: number;
        if (position === 'right') {
          percent = ((rect.right - ev.clientX) / rect.width) * 100;
        } else if (position === 'left') {
          percent = ((ev.clientX - rect.left) / rect.width) * 100;
        } else if (position === 'bottom') {
          percent = ((rect.bottom - ev.clientY) / rect.height) * 100;
        } else {
          percent = ((ev.clientY - rect.top) / rect.height) * 100;
        }
        onSizeChange(percent);
      };
      const onUp = () => {
        document.body.style.userSelect = prevSelect;
        document.body.style.cursor = prevCursor;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [position, containerRef, isHorizontal, onSizeChange],
  );

  return (
    <div
      onMouseDown={onMouseDown}
      className={`shrink-0 bg-gray-200 hover:bg-accent transition-colors ${
        isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
      }`}
      title="拖动调整大小"
    />
  );
}
