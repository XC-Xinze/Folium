import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpToLine, GripVertical, Layers } from 'lucide-react';
import { setCardDragData } from '../lib/dragCard';
import { api, type Card } from '../lib/api';
import { attachWikilinkHandler, renderMarkdown } from '../lib/markdown';
import type { CardNodeData } from '../lib/cardGraph';
import { NODE_WIDTH } from '../lib/cardGraph';
import { useNavigateToCard } from '../lib/useNavigateToCard';
import { useUIStore } from '../store/uiStore';

export function CardNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as CardNodeData;
  const { card, variant } = nodeData;
  // 关键：用 card.luhmannId 拉取，不用 React Flow 的 node id
  // 因为 workspace 里节点 id 是 workspace 本地 uuid，不是 luhmannId
  const cardLuhmannId = card.luhmannId;
  const [full, setFull] = useState<Card | null>(
    'contentMd' in card ? (card as Card) : null,
  );
  const navigate = useNavigateToCard();
  const setFocus = useUIStore((s) => s.setFocus);
  const setFocusTag = useUIStore((s) => s.setFocusTag);
  const qc = useQueryClient();
  const contentRef = useRef<HTMLDivElement>(null);
  const [promoting, setPromoting] = useState(false);
  void id; // 仅在某些场景需要，主体逻辑用 cardLuhmannId

  const onPromote = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`确定提权 ${cardLuhmannId} 吗？\n\n会重命名文件并更新所有引用 [[${cardLuhmannId}]] → [[新ID]]`)) return;
    setPromoting(true);
    try {
      const result = await api.promoteCard(cardLuhmannId);
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['indexes'] });
      qc.invalidateQueries({ queryKey: ['positions'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      navigate(result.newId);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setPromoting(false);
    }
  };

  const onDemote = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`确定降权 ${cardLuhmannId} 吗？\n\n卡片会变成下一个兄弟卡片的子卡，子树跟随移动。`)) return;
    setPromoting(true);
    try {
      const result = await api.demoteCard(cardLuhmannId);
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['indexes'] });
      qc.invalidateQueries({ queryKey: ['positions'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      navigate(result.newId);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setPromoting(false);
    }
  };

  // 摘要 → 按需拉取完整正文
  useEffect(() => {
    if (full) return;
    let cancelled = false;
    api
      .getCard(cardLuhmannId)
      .then((c) => {
        if (!cancelled) setFull(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cardLuhmannId, full]);

  useEffect(() => {
    if (!contentRef.current) return;
    return attachWikilinkHandler(contentRef.current, (target) => navigate(target));
  }, [navigate, full?.luhmannId]);

  const stylesByVariant = {
    focus: {
      border: 'border-2 border-ink',
      bg: 'bg-white',
      opacity: 'opacity-100',
      shadow: 'shadow-xl',
      badge: 'bg-ink text-white',
    },
    tree: {
      border: 'border border-gray-200',
      bg: 'bg-white',
      opacity: 'opacity-100',
      shadow: 'shadow-md',
      badge: 'bg-gray-100 text-gray-700',
    },
    'cross-flank': {
      border: 'border border-accent/40',
      bg: 'bg-white',
      opacity: 'opacity-95',
      shadow: 'shadow-md',
      badge: 'bg-accentSoft text-accent',
    },
    potential: {
      border: 'border border-dashed border-gray-300',
      bg: 'bg-white',
      opacity: 'opacity-55',
      shadow: 'shadow-sm',
      badge: 'bg-gray-100 text-gray-500',
    },
  } as const;
  const styles = stylesByVariant[variant];

  // 优先用已加载的 full（在 workspace 里 card 是 dummy）
  const display = full ?? card;
  const isIndex = 'status' in display && display.status === 'INDEX';
  const tags = 'tags' in display ? display.tags : [];
  const sharedBoxes = nodeData.sharedBoxes ?? [];
  const sharedBoxLabels = nodeData.sharedBoxLabels ?? [];
  const isShared = sharedBoxes.length > 1; // 被多个 INDEX 引用
  // 当前是从外部"借"过来的卡片（cross-flank / potential）—— 显示来源 box
  const focusedBoxId = useUIStore((s) => s.focusedBoxId);
  const otherBoxLabels = sharedBoxLabels.filter((b) => b.id !== focusedBoxId);
  const showSourceLabel =
    (variant === 'cross-flank' || variant === 'potential') && otherBoxLabels.length > 0;
  const html = full ? renderMarkdown(full.contentMd) : '';

  return (
    <div
      className={`group relative rounded-xl ${styles.border} ${styles.bg} ${styles.shadow} ${styles.opacity} cursor-default`}
      style={{ width: NODE_WIDTH }}
      onClick={(e) => {
        e.stopPropagation();
        // 单击：仅切换焦点高亮（不换 box / 不重新布局）
        setFocus(cardLuhmannId);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        // 双击：完整导航（可能换 box 或进入新树）
        navigate(cardLuhmannId);
      }}
    >
      {/* 拖拽手柄：可以把这张卡拖到工作区（用 nodrag 让 React Flow 不拦截） */}
      <div
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          setCardDragData(e, { luhmannId: cardLuhmannId, title: display.title });
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="nodrag absolute top-2 right-2 z-10 w-5 h-5 rounded text-gray-300 hover:text-accent hover:bg-accentSoft flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
        title="拖到工作区"
      >
        <GripVertical size={12} />
      </div>

      {/* Promote / Demote 按钮 — 仅 ATOMIC 卡 hover 时显示 */}
      {!isIndex && (
        <>
          <button
            onClick={onPromote}
            disabled={promoting}
            className="absolute -top-2 -left-2 z-10 w-6 h-6 rounded-full bg-amber-500 text-white shadow-md flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-amber-600 transition-all disabled:opacity-30"
            title={`提权 ${cardLuhmannId} → 父级的兄弟 (e.g., 1a2 → 1aa)`}
          >
            <ArrowUpToLine size={12} />
          </button>
          <button
            onClick={onDemote}
            disabled={promoting}
            className="absolute -top-2 left-6 z-10 w-6 h-6 rounded-full bg-sky-500 text-white shadow-md flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-sky-600 transition-all disabled:opacity-30"
            title={`降权 ${cardLuhmannId} → 下一个兄弟卡片的子卡`}
          >
            <ArrowDownToLine size={12} />
          </button>
        </>
      )}
      {/* tree 用上下；非 tree 关系（tag/cross/potential）用左右，避免边路径穿越 */}
      <Handle id="top" type="target" position={Position.Top} className="!bg-gray-300 !w-2 !h-2 !border-0" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="!bg-gray-300 !w-2 !h-2 !border-0" />
      <Handle id="left-in" type="target" position={Position.Left} className="!bg-transparent !w-2 !h-2 !border-0" />
      <Handle id="left-out" type="source" position={Position.Left} className="!bg-transparent !w-2 !h-2 !border-0" />
      <Handle id="right-in" type="target" position={Position.Right} className="!bg-transparent !w-2 !h-2 !border-0" />
      <Handle id="right-out" type="source" position={Position.Right} className="!bg-transparent !w-2 !h-2 !border-0" />

      <header className="px-5 pt-4 pb-3 flex items-start justify-between gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className={`font-mono text-[11px] font-bold px-1.5 py-0.5 rounded ${styles.badge}`}>
            {display.luhmannId}
          </span>
          <h3 className="text-[13px] font-bold tracking-tight truncate">{display.title || cardLuhmannId}</h3>
        </div>
        {isIndex && (
          <span className="shrink-0 text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent text-white">
            INDEX
          </span>
        )}
        {isShared && (
          <span
            className="shrink-0 flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200"
            title={`同时存在于：${sharedBoxes.join(', ')}`}
          >
            <Layers size={9} />
            {sharedBoxes.length}
          </span>
        )}
      </header>

      <div
        ref={contentRef}
        className="prose-card text-[12px] text-ink px-5 pb-4 max-h-72 overflow-hidden"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {tags.length > 0 && (
        <footer className="px-5 pb-3 flex flex-wrap gap-1.5 border-t border-gray-100 pt-2">
          {tags.slice(0, 6).map((t) => (
            <button
              key={t}
              onClick={(e) => {
                e.stopPropagation();
                setFocusTag(t);
              }}
              className="text-[9px] font-bold text-accent hover:underline cursor-pointer"
              title={`查看 #${t} 下所有卡片`}
            >
              #{t}
            </button>
          ))}
        </footer>
      )}

      {/* 来源盒子标签：本卡是从其他 box 借进来的 → 显示原属盒子 */}
      {showSourceLabel && (
        <div className="absolute -bottom-2.5 left-3 px-1.5 py-0.5 rounded text-[9px] font-bold bg-white border border-gray-300 text-gray-600 shadow-sm flex items-center gap-1">
          <span className="text-[8px]">↗</span>
          <span>来自</span>
          {otherBoxLabels.slice(0, 2).map((b, i) => (
            <span key={b.id} className="text-accent">
              {b.title}
              {i < Math.min(otherBoxLabels.length, 2) - 1 ? ', ' : ''}
            </span>
          ))}
          {otherBoxLabels.length > 2 && (
            <span className="text-gray-400">+{otherBoxLabels.length - 2}</span>
          )}
        </div>
      )}

    </div>
  );
}
