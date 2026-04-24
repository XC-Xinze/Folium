import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpToLine, Check, GripVertical, Layers, Pencil, Star, Trash2, X } from 'lucide-react';
import { setCardDragData } from '../lib/dragCard';
import { dialog } from '../lib/dialog';
import { api, type Card } from '../lib/api';
import { attachWikilinkHandler, renderMarkdown } from '../lib/markdown';
import type { CardNodeData } from '../lib/cardGraph';
import { NODE_WIDTH } from '../lib/cardGraph';
import { useNavigateToCard } from '../lib/useNavigateToCard';
import { useUIStore } from '../store/uiStore';

export function CardNode({ data, id, selected }: NodeProps) {
  const nodeData = data as unknown as CardNodeData;
  const { card, variant } = nodeData;
  const savedW = nodeData.savedW;
  const savedH = nodeData.savedH;
  const focusedBoxId = useUIStore((s) => s.focusedBoxId);
  const focusedTag = useUIStore((s) => s.focusedTag);
  const scope = focusedTag ? `tag:${focusedTag}` : `box:${focusedBoxId ?? ''}`;
  // 关键：用 card.luhmannId 拉取，不用 React Flow 的 node id
  // 因为 workspace 里节点 id 是 workspace 本地 uuid，不是 luhmannId
  const cardLuhmannId = card.luhmannId;
  const isGhost = !!nodeData.ghostFromWorkspace;
  const [full, setFull] = useState<Card | null>(
    'contentMd' in card ? (card as Card) : null,
  );
  const navigate = useNavigateToCard();
  const setFocus = useUIStore((s) => s.setFocus);
  const setFocusTag = useUIStore((s) => s.setFocusTag);
  const qc = useQueryClient();
  const starredQ = useQuery({ queryKey: ['starred'], queryFn: api.listStarred });
  const isStarred = !!starredQ.data?.ids.includes(cardLuhmannId);
  const contentRef = useRef<HTMLDivElement>(null);
  const [promoting, setPromoting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [draftStatus, setDraftStatus] = useState<'ATOMIC' | 'INDEX'>('ATOMIC');
  const [hovered, setHovered] = useState(false);
  // 实时尺寸：拖动时跟随光标更新，松开时持久化
  const [w, setW] = useState<number | undefined>(savedW);
  const [h, setH] = useState<number | undefined>(savedH);
  useEffect(() => { if (savedW != null) setW(savedW); }, [savedW]);
  useEffect(() => { if (savedH != null) setH(savedH); }, [savedH]);
  void id;

  const toggleStar = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (isStarred) await api.unstar(cardLuhmannId);
      else await api.star(cardLuhmannId);
      qc.invalidateQueries({ queryKey: ['starred'] });
    } catch (err) {
      console.error('toggle star failed', err);
    }
  };

  const onPromote = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await dialog.confirm(`Promote ${cardLuhmannId}?`, {
      title: 'Promote card',
      description: `The .md file will be renamed and every [[${cardLuhmannId}]] reference updated to the new id.`,
      confirmLabel: 'Promote',
    });
    if (!ok) return;
    setPromoting(true);
    try {
      const result = await api.promoteCard(cardLuhmannId);
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['indexes'] });
      qc.invalidateQueries({ queryKey: ['positions'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      navigate(result.newId);
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Promote failed' });
    } finally {
      setPromoting(false);
    }
  };

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!full) return;
    setDraftTitle(full.title);
    setDraftContent(full.contentMd);
    setDraftTags(full.tags.join(', '));
    setDraftStatus(full.status);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!full) return;
    try {
      const tagsList = draftTags
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const updated = await api.updateCard(cardLuhmannId, {
        title: draftTitle,
        content: draftContent,
        tags: tagsList,
        status: draftStatus,
      });
      setFull(updated);
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['indexes'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      qc.invalidateQueries({ queryKey: ['card'] });
      qc.invalidateQueries({ queryKey: ['linked'] });
      setEditing(false);
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Save failed' });
    }
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const onDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // In a workspace: only remove the workspace node, leave vault untouched
    if (nodeData.onDeleteOverride) {
      const ok = await dialog.confirm(`Remove ${cardLuhmannId} from this workspace?`, {
        title: 'Remove from workspace',
        description: 'The vault card itself stays untouched.',
        confirmLabel: 'Remove',
        variant: 'danger',
      });
      if (!ok) return;
      nodeData.onDeleteOverride();
      return;
    }
    const ok = await dialog.confirm(`Delete ${cardLuhmannId}?`, {
      title: 'Delete card',
      description:
        'The .md file will be removed and crossLinks from other cards cleaned up.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    setPromoting(true);
    try {
      await api.deleteCard(cardLuhmannId);
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['indexes'] });
      qc.invalidateQueries({ queryKey: ['positions'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      qc.invalidateQueries({ queryKey: ['workspaces'] });
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Delete failed' });
    } finally {
      setPromoting(false);
    }
  };

  const onDemote = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await dialog.confirm(`Demote ${cardLuhmannId}?`, {
      title: 'Demote card',
      description:
        'The card becomes a child of its next sibling. Its subtree moves with it.',
      confirmLabel: 'Demote',
    });
    if (!ok) return;
    setPromoting(true);
    try {
      const result = await api.demoteCard(cardLuhmannId);
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['indexes'] });
      qc.invalidateQueries({ queryKey: ['positions'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      navigate(result.newId);
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Demote failed' });
    } finally {
      setPromoting(false);
    }
  };

  // 摘要 → 按需拉取完整正文（ghost 节点已带内容，跳过）
  useEffect(() => {
    if (full || isGhost) return;
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
  }, [cardLuhmannId, full, isGhost]);

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
    'tag-related': {
      border: 'border border-emerald-300',
      bg: 'bg-white',
      opacity: 'opacity-95',
      shadow: 'shadow-md',
      badge: 'bg-emerald-50 text-emerald-700',
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
  // 当前是从外部"借"过来的卡片（cross-flank / tag-related / potential）—— 显示来源 box
  const otherBoxLabels = sharedBoxLabels.filter((b) => b.id !== focusedBoxId);
  const showSourceLabel =
    (variant === 'cross-flank' || variant === 'tag-related' || variant === 'potential') &&
    otherBoxLabels.length > 0;
  const html = full ? renderMarkdown(full.contentMd) : '';

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`group relative rounded-xl ${styles.border} ${styles.bg} ${styles.shadow} ${styles.opacity} cursor-default flex flex-col`}
      style={{
        width: w ?? NODE_WIDTH,
        height: h,
      }}
      onClick={() => {
        if (isGhost) return;
        setFocus(cardLuhmannId);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (isGhost) return;
        navigate(cardLuhmannId);
      }}
    >
      {/* 拖拽手柄：右下角；workspace 内不显示，ghost 也不显示 */}
      {!nodeData.isInWorkspace && !isGhost && (
        <div
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            setCardDragData(e, { luhmannId: cardLuhmannId, title: display.title });
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag nopan absolute bottom-2 right-2 z-20 px-1.5 py-0.5 rounded flex items-center gap-1 bg-white/90 hover:bg-accent hover:text-white text-gray-400 cursor-grab active:cursor-grabbing border border-gray-200 hover:border-accent shadow-sm transition-colors text-[9px] font-bold uppercase tracking-wider"
          title="Drag to workspace"
        >
          <GripVertical size={10} />
          <span>WS</span>
        </div>
      )}

      {/* Promote / Demote / Delete / Edit buttons — visible on hover (ghost 不显示) */}
      {!isIndex && !isGhost && (
        <>
          <button
            onClick={onPromote}
            disabled={promoting}
            className="absolute -top-2 -left-2 z-10 w-6 h-6 rounded-full bg-amber-500 text-white shadow-md flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-amber-600 transition-all disabled:opacity-30"
            title={`Promote ${cardLuhmannId} to parent's sibling (e.g. 1a2 → 1aa)`}
          >
            <ArrowUpToLine size={12} />
          </button>
          <button
            onClick={onDemote}
            disabled={promoting}
            className="absolute -top-2 left-6 z-10 w-6 h-6 rounded-full bg-sky-500 text-white shadow-md flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-sky-600 transition-all disabled:opacity-30"
            title={`Demote ${cardLuhmannId} to child of next sibling`}
          >
            <ArrowDownToLine size={12} />
          </button>
        </>
      )}
      {!isGhost && (
        <button
          onClick={onDelete}
          disabled={promoting || editing}
          className="absolute -top-2 -right-2 z-10 w-6 h-6 rounded-full bg-red-500 text-white shadow-md flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-all disabled:opacity-30"
          title={`Delete ${cardLuhmannId}`}
        >
          <Trash2 size={12} />
        </button>
      )}
      {!isGhost && (
        <button
          onClick={startEdit}
          disabled={promoting || editing || !full}
          className="absolute -top-2 right-6 z-10 w-6 h-6 rounded-full bg-gray-700 text-white shadow-md flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-ink transition-all disabled:opacity-30"
          title={`Edit ${cardLuhmannId}`}
        >
          <Pencil size={11} />
        </button>
      )}
      {!isGhost && (
        <button
          onClick={toggleStar}
          className={`absolute -top-2 right-14 z-10 w-6 h-6 rounded-full shadow-md flex items-center justify-center transition-all ${
            isStarred
              ? 'bg-amber-400 text-white opacity-100'
              : 'bg-gray-200 text-gray-500 opacity-0 group-hover:opacity-100 hover:bg-amber-400 hover:text-white'
          }`}
          title={isStarred ? `Unstar ${cardLuhmannId}` : `Star ${cardLuhmannId}`}
        >
          <Star size={11} fill={isStarred ? 'currentColor' : 'none'} />
        </button>
      )}
      {/* Resize: 8 handles visible on hover/select. Saved to positions.w/h */}
      {!isGhost && (
        <NodeResizer
          isVisible={hovered || selected}
          minWidth={240}
          minHeight={180}
          lineClassName="!border-accent/40"
          handleClassName="!bg-accent !border !border-white !w-2 !h-2"
          onResize={(_e, params) => {
            setW(params.width);
            setH(params.height);
          }}
          onResizeEnd={(_e, params) => {
            api.setSize(scope, cardLuhmannId, params.width, params.height).catch((err) => {
              console.error('save size failed', err);
            });
          }}
        />
      )}
      {/* Tree edges use top/bottom; tag/cross/potential use left/right to avoid edge-path collisions */}
      <Handle id="top" type="target" position={Position.Top} className="!bg-gray-300 !w-2 !h-2 !border-0" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="!bg-gray-300 !w-2 !h-2 !border-0" />
      <Handle id="left-in" type="target" position={Position.Left} className="!bg-transparent !w-2 !h-2 !border-0" />
      <Handle id="left-out" type="source" position={Position.Left} className="!bg-transparent !w-2 !h-2 !border-0" />
      <Handle id="right-in" type="target" position={Position.Right} className="!bg-transparent !w-2 !h-2 !border-0" />
      <Handle id="right-out" type="source" position={Position.Right} className="!bg-transparent !w-2 !h-2 !border-0" />

      {editing ? (
        // ━━━ Edit mode ━━━
        <div className="nodrag nopan p-3 space-y-2" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2">
            <span className={`font-mono text-[11px] font-bold px-1.5 py-0.5 rounded ${styles.badge}`}>
              {display.luhmannId}
            </span>
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              className="flex-1 text-[13px] font-bold px-2 py-1 border border-gray-200 rounded focus:border-accent outline-none"
              placeholder="Title"
            />
            <select
              value={draftStatus}
              onChange={(e) => setDraftStatus(e.target.value as 'ATOMIC' | 'INDEX')}
              className="text-[10px] font-bold px-1 py-0.5 border border-gray-200 rounded outline-none"
            >
              <option value="ATOMIC">Atomic</option>
              <option value="INDEX">Index</option>
            </select>
          </div>
          <textarea
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
            placeholder="Markdown body — supports [[link]] and #tag"
            className="w-full text-[12px] font-mono px-2 py-1 border border-gray-200 rounded focus:border-accent outline-none resize-y"
            rows={8}
          />
          <input
            value={draftTags}
            onChange={(e) => setDraftTags(e.target.value)}
            placeholder="Tags (comma-separated)"
            className="w-full text-[11px] px-2 py-1 border border-gray-200 rounded focus:border-accent outline-none"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={cancelEdit}
              className="text-[11px] font-bold px-3 py-1 rounded text-gray-500 hover:bg-gray-100 flex items-center gap-1"
            >
              <X size={11} /> Cancel
            </button>
            <button
              onClick={saveEdit}
              className="text-[11px] font-bold px-3 py-1 rounded bg-accent text-white hover:bg-accent/90 flex items-center gap-1"
            >
              <Check size={11} /> Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <header className="px-5 pt-4 pb-3 flex items-start justify-between gap-3">
            <div className="flex items-baseline gap-2 min-w-0">
              {isGhost ? (
                <span className="font-mono text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded bg-purple-100 text-purple-600">
                  Temp
                </span>
              ) : (
                <span className={`font-mono text-[11px] font-bold px-1.5 py-0.5 rounded ${styles.badge}`}>
                  {display.luhmannId}
                </span>
              )}
              <h3 className="text-[13px] font-bold tracking-tight truncate">
                {display.title || (isGhost ? '(untitled temp)' : cardLuhmannId)}
              </h3>
            </div>
            {isIndex && (
              <span className="shrink-0 text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent text-white">
                INDEX
              </span>
            )}
            {isShared && (
              <span
                className="shrink-0 flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200"
                title={`Also indexed by: ${sharedBoxes.join(', ')}`}
              >
                <Layers size={9} />
                {sharedBoxes.length}
              </span>
            )}
          </header>

          <div
            ref={contentRef}
            className={`prose-card text-[12px] text-ink px-5 pb-4 ${
              h ? 'flex-1 overflow-y-auto' : 'max-h-72 overflow-hidden'
            }`}
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
                  title={`Show all cards tagged #${t}`}
                >
                  #{t}
                </button>
              ))}
            </footer>
          )}
        </>
      )}

      {/* Ghost-from-workspace label */}
      {isGhost && nodeData.ghostFromWorkspace && (
        <div className="absolute -bottom-2.5 left-3 px-1.5 py-0.5 rounded text-[9px] font-bold bg-white border border-purple-300 text-purple-600 shadow-sm flex items-center gap-1">
          <span className="text-[8px]">⌘</span>
          <span>from workspace</span>
          <span className="text-purple-700">{nodeData.ghostFromWorkspace.workspaceName}</span>
        </div>
      )}

      {/* Source-box label: this card is borrowed from another box */}
      {!isGhost && showSourceLabel && (
        <div className="absolute -bottom-2.5 left-3 px-1.5 py-0.5 rounded text-[9px] font-bold bg-white border border-gray-300 text-gray-600 shadow-sm flex items-center gap-1">
          <span className="text-[8px]">↗</span>
          <span>from</span>
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
