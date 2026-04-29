import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, GripVertical, Image, Layers, Link2, Pencil, Star, Trash2, X } from 'lucide-react';
import { isCardDrag, readCardDragData, setCardDragData } from '../lib/dragCard';
import { dialog } from '../lib/dialog';
import { api, type Card, type PositionMap } from '../lib/api';
import { countWords, relativeTime } from '../lib/cardStats';
import { attachAttachmentClickHandler, attachTransclusion, attachWikilinkHandler, renderMarkdown } from '../lib/markdown';
import type { CardNodeData } from '../lib/cardGraph';
import { NODE_WIDTH } from '../lib/cardGraph';
import { useNavigateToCard } from '../lib/useNavigateToCard';
import { useUIStore } from '../store/uiStore';
import { usePaneStore as usePaneStoreImported } from '../store/paneStore';
import { applyTrigger, detectTrigger, formatInsertion, type Trigger } from '../lib/editorAutocomplete';
import { pushUndo } from '../lib/undoStack';
import { fuzzyScore } from '../lib/fuzzy';
import { EditorAutocomplete, type AutocompleteItem } from './EditorAutocomplete';

export function CardNode({ data, id, selected, positionAbsoluteX, positionAbsoluteY }: NodeProps) {
  const nodeData = data as unknown as CardNodeData;
  const { card, variant } = nodeData;
  const savedW = nodeData.savedW;
  const savedH = nodeData.savedH;
  // scope 从 nodeData 来（Canvas/TagView 注入），不读全局 useUIStore —— 避免多 pane 串
  const focusedBoxId = useUIStore((s) => s.focusedBoxId); // 仅用于 sharedBoxes 标签判断
  const focusedCardId = useUIStore((s) => s.focusedCardId); // promote-to-link 需要知道源卡
  const scope = nodeData.scope ?? `box:${focusedBoxId ?? ''}`;
  // 关键：用 card.luhmannId 拉取，不用 React Flow 的 node id
  // 因为 workspace 里节点 id 是 workspace 本地 uuid，不是 luhmannId
  const cardLuhmannId = card.luhmannId;
  const isGhost = !!nodeData.ghostFromWorkspace;
  const superlinkSelection = nodeData.superlinkSelection;
  // 用 useQuery 订阅卡片内容；这样 tag 改名 / 删除等操作 invalidate ['card', id] 时
  // 这里会自动 refetch，不会一直拿初次加载的 stale 副本
  // 注意：用 placeholderData（不是 initialData）来给"首屏"展示——initialData 会
  // 当成已加载的真数据塞进 cache，反而抑制 refetch
  const fullQ = useQuery({
    queryKey: ['card', cardLuhmannId],
    queryFn: () => api.getCard(cardLuhmannId),
    enabled: !isGhost,
    placeholderData: 'contentMd' in card ? (card as Card) : undefined,
  });
  const full: Card | null = isGhost ? (card as Card) : (fullQ.data ?? null);
  const navigate = useNavigateToCard();
  // 旧 setFocusTag 改成开 tag tab
  const _openTagTab = (name: string) =>
    usePaneStoreImported.getState().openTab({ kind: 'tag', title: `#${name}`, tagName: name });

  // 单击 CardNode → 更新当前 active tab 的 cardFocusId
  // 深度限制：累计 3 层外部 tag/cross 卡后，下一次点外部卡切到对方的 box（重置链）
  // 内部 (tree/focus) 卡片不计深度，且重置链
  // navigateInTab 同时维护 history 给 ⌘[ ⌘] 用
  const MAX_DEPTH = 3;
  const setFocus = (cardId: string) => {
    const { root, activeLeafId, updateTab, navigateInTab } = usePaneStoreImported.getState();
    const findLeaf = (n: typeof root): typeof root | null => {
      if (n.kind === 'leaf') return n.id === activeLeafId ? n : null;
      for (const c of n.children) {
        const r = findLeaf(c);
        if (r) return r;
      }
      return null;
    };
    const leaf = findLeaf(root);
    if (!leaf || leaf.kind !== 'leaf' || !leaf.activeTabId) return;
    const activeTab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
    if (!activeTab || activeTab.kind !== 'card' || !activeTab.cardBoxId) return;

    const isExternal = variant === 'tag-related' || variant === 'cross-flank' || variant === 'potential';
    if (!isExternal) {
      navigateInTab(leaf.id, leaf.activeTabId, { box: activeTab.cardBoxId, focus: cardId });
      updateTab(leaf.id, leaf.activeTabId, { cardFocusDepth: 0 });
      return;
    }
    const nextDepth = (activeTab.cardFocusDepth ?? 0) + 1;
    if (nextDepth > MAX_DEPTH) {
      // 已到最大深度 —— 不再让外部链接继续向更深扩散：
      // 不切 box（避免画布整片重置），不增 depth，不动 focus。
      // 用户想继续探索就 ⌘[ 退一步，或在 sidebar 跳到目标 box。
      return;
    }
    navigateInTab(leaf.id, leaf.activeTabId, { box: activeTab.cardBoxId, focus: cardId });
    updateTab(leaf.id, leaf.activeTabId, { cardFocusDepth: nextDepth });
  };
  const qc = useQueryClient();
  const starredQ = useQuery({ queryKey: ['starred'], queryFn: api.listStarred });
  const isStarred = !!starredQ.data?.ids.includes(cardLuhmannId);
  const openGhostWorkspace = () => {
    const ws = nodeData.ghostFromWorkspace;
    if (!ws) return;
    usePaneStoreImported.getState().openTab({
      kind: 'workspace',
      title: ws.workspaceName,
      workspaceId: ws.workspaceId,
    });
  };
  const contentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [promoting, setPromoting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftTags, setDraftTags] = useState('');
  // status 不再可编辑 —— 它从结构派生（有 Folgezettel 子卡 = INDEX）
  const [hovered, setHovered] = useState(false);
  const [linkDropOver, setLinkDropOver] = useState(false); // 拖卡到本卡 → 加 [[link]] 时的 hover 高亮
  // Autocomplete 状态：编辑模式下用
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [acIdx, setAcIdx] = useState(0);
  const [anchorRect, setAnchorRect] = useState<{ top: number; left: number; bottom: number } | null>(
    null,
  );
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

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!full) return;
    setDraftTitle(full.title);
    setDraftContent(full.contentMd);
    setDraftTags(full.tags.join(', '));
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
      });
      // 写完先把这张卡的 query 内容直接替换掉，再 invalidate 让其他视图统一刷
      qc.setQueryData(['card', cardLuhmannId], updated);
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['indexes'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      qc.invalidateQueries({ queryKey: ['linked'] });
      qc.invalidateQueries({ queryKey: ['backlinks'] });
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
      usePaneStoreImported.getState().removeTabsWhere(
        (t) => t.kind === 'card' && (t.cardBoxId === cardLuhmannId || t.cardFocusId === cardLuhmannId),
      );
      // 注册 undo：从 trash 找最近一条对应这张卡的，restore 即可
      pushUndo({
        description: `Deleted card ${cardLuhmannId}`,
        undo: async () => {
          const trash = await api.listTrash();
          const entry = trash.entries.find((e) => e.luhmannId === cardLuhmannId);
          if (!entry) throw new Error('Trash entry not found');
          await api.restoreTrash(entry.fileName);
          qc.invalidateQueries();
        },
      });
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Delete failed' });
    } finally {
      setPromoting(false);
    }
  };

  useEffect(() => {
    if (!contentRef.current) return;
    return attachWikilinkHandler(contentRef.current, (target) => navigate(target));
  }, [navigate, full?.luhmannId]);

  // 普通 markdown 链接 [label](attachments/foo.pdf) → 调系统 open（不在浏览器内打开）
  useEffect(() => {
    if (!contentRef.current) return;
    return attachAttachmentClickHandler(contentRef.current, (rel) => {
      api.openAttachment(rel).catch((err) => {
        console.error('open attachment failed', err);
      });
    });
  }, [full?.luhmannId]);

  // ![[id]] 嵌入：内容 / 渲染完成后异步填充
  useEffect(() => {
    if (!contentRef.current || !full) return;
    let cancelled = false;
    void attachTransclusion(contentRef.current, async (id) => {
      if (cancelled) return null;
      try {
        return await api.getCard(id);
      } catch {
        return null;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [full?.luhmannId, full?.contentMd]);

  // Dark 用 Catppuccin Macchiato：surface0=#363a4f (卡 bg), surface1=#494d64 (border),
  // text=#cad3f5, sage=#a7c7a1 (focus), green=#a6da95 (tag)
  const stylesByVariant = {
    focus: {
      border: 'border-2 border-ink dark:border-[#a7c7a1]',
      bg: 'bg-paper dark:bg-[#363a4f]',
      opacity: 'opacity-100',
      shadow: 'shadow-[0_2px_3px_rgba(45,45,45,0.05),0_18px_44px_rgba(45,45,45,0.14)]',
      badge: 'bg-ink text-white dark:bg-[#a7c7a1] dark:text-[#24273a]',
    },
    tree: {
      border: 'border border-paperEdge dark:border-[#494d64]',
      bg: 'bg-paper dark:bg-[#363a4f]',
      opacity: 'opacity-100',
      shadow: 'shadow-paper',
      badge: 'bg-gray-100 dark:bg-[#494d64] text-gray-700 dark:text-[#cad3f5]',
    },
    'cross-flank': {
      border: 'border border-link dark:border-[#9bc2cf]',
      bg: 'bg-paper dark:bg-[#363a4f]',
      opacity: 'opacity-100',
      shadow: 'shadow-paper',
      badge: 'bg-[#d2e5f3] text-link dark:bg-[#9bc2cf]/20 dark:text-[#9bc2cf]',
    },
    'tag-related': {
      border: 'border border-emerald-400 dark:border-[#a6da95]',
      bg: 'bg-paper dark:bg-[#363a4f]',
      opacity: 'opacity-100',
      shadow: 'shadow-paper',
      badge: 'bg-emerald-50 text-emerald-700 dark:bg-[#a6da95]/15 dark:text-[#a6da95]',
    },
    potential: {
      // 用虚线边框 + 较小阴影区分"弱关系"，不再用透明度
      border: 'border border-dashed border-paperEdge dark:border-[#6e738d]',
      bg: 'bg-[#f7f6ef] dark:bg-[#363a4f]',
      opacity: 'opacity-100',
      shadow: 'shadow-[0_1px_2px_rgba(45,45,45,0.04),0_8px_20px_rgba(45,45,45,0.06)]',
      badge: 'bg-gray-100 dark:bg-[#494d64] text-gray-500 dark:text-[#a5adcb]',
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
  // markdown 解析非 trivial — 只在内容变化时跑，否则 hover/resize 都会触发整段重新解析
  const html = useMemo(() => (full ? renderMarkdown(full.contentMd) : ''), [full?.contentMd]);

  // Backlinks：只对焦点卡拉，其他卡片不需要 → 别让背景卡片刷一堆请求
  const backlinksQ = useQuery({
    queryKey: ['backlinks', cardLuhmannId],
    queryFn: () => api.getReferencedFrom(cardLuhmannId),
    enabled: variant === 'focus' && !isGhost,
  });
  const backlinks = backlinksQ.data?.hits ?? [];
  const [backlinksOpen, setBacklinksOpen] = useState(false);

  // Autocomplete 候选：编辑模式下，依据 trigger 类型从 cards / tags 里筛
  const allCardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards, enabled: editing });
  const allTagsQ = useQuery({ queryKey: ['tags'], queryFn: api.listTags, enabled: editing });
  const acItems: AutocompleteItem[] = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    if (trigger.kind === 'tag') {
      const tags = allTagsQ.data?.tags ?? [];
      return tags
        .map((t) => ({
          item: { label: t.name, hint: `${t.count}`, value: t.name } as AutocompleteItem,
          score: q ? Math.max(fuzzyScore(q, t.name), 0) : 500 - t.count, // 空 query → 高频在前
        }))
        .filter((x) => !q || x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
        .map((x) => x.item);
    }
    // wikilink / transclusion
    const cards = allCardsQ.data?.cards ?? [];
    return cards
      .map((c) => ({
        item: {
          label: c.title || c.luhmannId,
          hint: c.status === 'INDEX' ? 'INDEX' : '',
          value: c.luhmannId,
        } as AutocompleteItem,
        score: q
          ? Math.max(fuzzyScore(q, c.luhmannId), fuzzyScore(q, c.title))
          : 1000 - c.sortKey.length, // 空 query → 短 sortKey 在前
      }))
      .filter((x) => !q || x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((x) => x.item);
  }, [trigger, allCardsQ.data, allTagsQ.data]);

  // 检测 textarea 当前光标位置 → 更新 trigger
  const refreshTrigger = (textarea: HTMLTextAreaElement) => {
    const t = detectTrigger(textarea.value, textarea.selectionStart);
    setTrigger(t);
    setAcIdx(0);
    if (t) {
      const rect = textarea.getBoundingClientRect();
      // 简单定位：放在 textarea 下方左侧。精确光标位置太复杂，先这样。
      setAnchorRect({ top: rect.top, left: rect.left, bottom: rect.bottom });
    } else {
      setAnchorRect(null);
    }
  };

  const acceptAutocomplete = (item: AutocompleteItem) => {
    if (!trigger || !textareaRef.current) return;
    const ta = textareaRef.current;
    const replacement = formatInsertion(trigger.kind, item.value);
    const out = applyTrigger(ta.value, trigger, replacement, ta.selectionStart);
    setDraftContent(out.text);
    setTrigger(null);
    // 把光标放到插入末尾
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(out.caret, out.caret);
    });
  };

  // 在光标位置插入一段文本（用于图片上传完成后的占位符替换）
  const insertAtCaret = (insert: string, replaceFromTo?: { from: number; to: number }) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = replaceFromTo?.from ?? ta.selectionStart;
    const end = replaceFromTo?.to ?? ta.selectionEnd;
    const next = ta.value.slice(0, start) + insert + ta.value.slice(end);
    setDraftContent(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + insert.length, start + insert.length);
    });
  };

  // 上传文件并替换 placeholder。失败 → 把 placeholder 删掉。
  const handleFiles = async (files: File[]) => {
    if (!textareaRef.current) return;
    const ta = textareaRef.current;
    const baseStart = ta.selectionStart;
    // 先插占位符，让用户立刻看到反馈
    let placeholder = '';
    for (const f of files) placeholder += `![uploading ${f.name}…]()\n`;
    insertAtCaret(placeholder);
    const placeholderEnd = baseStart + placeholder.length;

    let cursor = baseStart;
    let replacement = '';
    for (const f of files) {
      try {
        const up = await api.uploadAttachment(f, focusedBoxId);
        const isImage = up.mimetype.startsWith('image/');
        const alt = up.filename.replace(/\.[^.]+$/, '');
        replacement += isImage
          ? `![${alt}](${up.relativePath})\n`
          : `[${up.filename}](${up.relativePath})\n`;
      } catch (err) {
        replacement += `<!-- upload failed: ${(err as Error).message} -->\n`;
      }
      cursor += 1;
    }
    void cursor;
    // 把所有 placeholder 一次性替换掉
    insertAtCaret(replacement, { from: baseStart, to: placeholderEnd });
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragOver={(e) => {
        // dragOver 阶段大多数浏览器禁止读 dataTransfer.getData —— 只能用 .types 判 mime。
        // 自身/顶级 vs 顶级 这些精细规则等到 drop 才检查。
        if (!isCardDrag(e) || isGhost) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        setLinkDropOver(true);
      }}
      onDragLeave={() => setLinkDropOver(false)}
      onDrop={async (e) => {
        if (!isCardDrag(e) || isGhost) return;
        const dragged = readCardDragData(e);
        setLinkDropOver(false);
        if (!dragged || dragged.luhmannId === cardLuhmannId) return;
        e.preventDefault();
        e.stopPropagation();
        // Workspace 上下文：通过 onCardLinkDrop 回调创建 workspace edge（不动 vault）
        if (nodeData.isInWorkspace && nodeData.onCardLinkDrop) {
          nodeData.onCardLinkDrop(dragged.luhmannId);
          return;
        }
        // Vault 上下文：写 [[link]] 到本卡 body
        try {
          await api.appendCrossLink(cardLuhmannId, dragged.luhmannId);
          qc.invalidateQueries({ queryKey: ['card', cardLuhmannId] });
          qc.invalidateQueries({ queryKey: ['cards'] });
          qc.invalidateQueries({ queryKey: ['linked'] });
          qc.invalidateQueries({ queryKey: ['related-batch'] });
        } catch (err) {
          dialog.alert((err as Error).message, { title: 'Link failed' });
        }
      }}
      className={`nowheel group relative rounded-lg zk-paper-surface ${styles.border} ${styles.opacity} cursor-default flex flex-col transition-shadow duration-150 ${
        linkDropOver ? 'ring-2 ring-accent ring-offset-2' : ''
      } ${
        superlinkSelection?.active
          ? superlinkSelection.selected
            ? 'ring-4 ring-accent ring-offset-2'
            : 'ring-2 ring-gray-300 ring-offset-1 hover:ring-accent/60'
          : ''
      }`}
      style={{
        width: w ?? NODE_WIDTH,
        height: h,
      }}
      onClick={(e) => {
        if (superlinkSelection?.active) {
          e.stopPropagation();
          if (!isGhost) superlinkSelection.onToggle(cardLuhmannId);
          return;
        }
        if (isGhost) return;
        setFocus(cardLuhmannId);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (isGhost) {
          openGhostWorkspace();
          return;
        }
        navigate(cardLuhmannId);
      }}
    >
      {superlinkSelection?.active && !isGhost && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            superlinkSelection.onToggle(cardLuhmannId);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className={`nodrag nopan absolute -top-3 -right-3 z-30 w-7 h-7 rounded-full border-2 shadow-md flex items-center justify-center transition-colors ${
            superlinkSelection.selected
              ? 'bg-accent text-white border-accent'
              : 'bg-white dark:bg-[#363a4f] text-gray-400 border-gray-300 hover:border-accent hover:text-accent'
          }`}
          title={superlinkSelection.selected ? 'Selected for workspace' : 'Pick this card'}
        >
          <Check size={14} strokeWidth={3} />
        </button>
      )}

      {/* 链接/重编号手柄：右下角通用 LINK 手柄。
           - 拖到另一张 canvas 卡 → 写 [[link]]
           - 拖到 sidebar Folgezettel 节点 → reparent + 重编号
           - 拖到 workspace → 加进 workspace
           workspace 内不显示，ghost 不显示，编辑时隐藏避免跟 Done 按钮叠 */}
      {!nodeData.isInWorkspace && !isGhost && !editing && (
        <div
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            setCardDragData(e, { luhmannId: cardLuhmannId, title: display.title });
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag nopan zk-subtle-button absolute bottom-2 right-2 z-20 px-1.5 py-0.5 rounded flex items-center gap-1 cursor-grab active:cursor-grabbing border shadow-sm transition-colors text-[9px] font-bold uppercase tracking-wider"
          title="Link/reparent handle: drop on another card to link, on sidebar tree to reparent, on workspace to add"
        >
          <GripVertical size={10} />
          <span>LINK</span>
        </div>
      )}
      {nodeData.isInWorkspace && !isGhost && !editing && (
        <div
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            setCardDragData(e, { luhmannId: cardLuhmannId, title: display.title });
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag nopan zk-subtle-button absolute bottom-2 left-2 z-20 px-1.5 py-0.5 rounded flex items-center gap-1 cursor-grab active:cursor-grabbing border shadow-sm transition-colors text-[9px] font-bold uppercase tracking-wider"
          title="Drag onto another workspace card to connect them"
        >
          <Link2 size={10} />
          <span>CONNECT</span>
        </div>
      )}

      {/* Floating card actions. Structure changes now go through drag/reparent handles. */}
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
          className="absolute -top-2 right-6 z-10 w-6 h-6 rounded-full bg-ink text-white shadow-md flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-accent transition-all disabled:opacity-30"
          title={`Edit ${cardLuhmannId}`}
        >
          <Pencil size={11} />
        </button>
      )}
      {/* Promote potential → real [[link]] 按钮已迁移到 potential 边中点（CanvasEdges.PotentialEdge）。
           跟卡角其他按钮不重叠，并且对边的 "source-target" 语义更清晰。 */}
      {!isGhost && (
        <button
          onClick={toggleStar}
          className={`absolute -top-2 right-14 z-10 w-6 h-6 rounded-full shadow-md flex items-center justify-center transition-all ${
            isStarred
              ? 'bg-amber-400 text-white opacity-100'
              : 'zk-subtle-button border text-gray-500 opacity-0 group-hover:opacity-100 hover:bg-amber-400 hover:text-white'
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
            if (nodeData.onResizeOverride) {
              nodeData.onResizeOverride(params.width, params.height);
              return;
            }
            qc.setQueryData<PositionMap>(['positions', scope], (old = {}) => ({
              ...old,
              [cardLuhmannId]: {
                x: old[cardLuhmannId]?.x ?? positionAbsoluteX,
                y: old[cardLuhmannId]?.y ?? positionAbsoluteY,
                w: params.width,
                h: params.height,
              },
            }));
            api
              .setPosition(scope, cardLuhmannId, positionAbsoluteX, positionAbsoluteY, params.width, params.height)
              .catch((err) => {
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
            {/* status 是 derived（有子卡 = INDEX），不在编辑面板里 */}
          </div>
          <textarea
            ref={textareaRef}
            value={draftContent}
            onChange={(e) => {
              setDraftContent(e.target.value);
              refreshTrigger(e.target);
            }}
            onKeyUp={(e) => refreshTrigger(e.currentTarget)}
            onClick={(e) => refreshTrigger(e.currentTarget)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length > 0) {
                e.preventDefault();
                void handleFiles(files);
              }
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={(e) => {
              const files = Array.from(e.dataTransfer.files);
              if (files.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                void handleFiles(files);
              }
            }}
            onKeyDown={(e) => {
              // 仅当 autocomplete 打开且有候选时，拦截导航键
              if (trigger && acItems.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setAcIdx((i) => Math.min(i + 1, acItems.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setAcIdx((i) => Math.max(i - 1, 0));
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  const sel = acItems[acIdx];
                  if (sel) acceptAutocomplete(sel);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setTrigger(null);
                  return;
                }
              }
            }}
            placeholder="Markdown body — [[link, ![[embed, #tag with autocomplete"
            className="w-full text-[12px] font-mono px-2 py-1 border border-gray-200 rounded focus:border-accent outline-none resize-y"
            rows={8}
          />
          <EditorAutocomplete
            open={!!trigger && acItems.length > 0}
            kind={trigger?.kind ?? null}
            items={acItems}
            activeIdx={acIdx}
            setActiveIdx={setAcIdx}
            onAccept={acceptAutocomplete}
            anchorRect={anchorRect}
          />
          {/* 编辑工具条：插入图片 / 提示 */}
          <div className="flex items-center gap-2 text-[10px] text-gray-400">
            <label className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-accent">
              <Image size={11} />
              <span className="font-bold">Image</span>
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = e.target.files;
                  if (files && files.length > 0) {
                    void handleFiles(Array.from(files));
                    e.target.value = '';
                  }
                }}
              />
            </label>
            <span>or just paste / drag image into the box</span>
          </div>
          <TagSuggestionsRow
            cardId={cardLuhmannId}
            currentTags={draftTags}
            onAddTag={(name) => {
              const cur = draftTags.trim();
              setDraftTags(cur ? `${cur}, ${name}` : name);
            }}
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
          <header
            className="px-5 pt-4 pb-3 flex items-start justify-between gap-3 cursor-grab active:cursor-grabbing border-b border-paperEdge/70 bg-gradient-to-b from-white/55 to-transparent dark:border-[#494d64] dark:from-white/5"
            title="Drag this header to move the card"
          >
            <div className="flex items-baseline gap-2 min-w-0">
              {isGhost ? (
                <span className="font-mono text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded bg-surfaceAlt text-accent">
                  Temp
                </span>
              ) : (
                // luhmann id 徽章本身就是 link drag handle ——
                // 拖它到另一张卡 = 写 [[thisId]] 进对方 body。
                // nodrag 阻止 React Flow 把 mousedown 当节点位置拖；HTML5 drag 仍然 fire。
                <span
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation();
                    setCardDragData(e, { luhmannId: cardLuhmannId, title: display.title });
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  className={`nodrag nopan font-mono text-[11px] font-bold px-1.5 py-0.5 rounded cursor-grab active:cursor-grabbing hover:ring-2 hover:ring-accent ${styles.badge}`}
                  title={
                    nodeData.isInWorkspace
                      ? `Drag ${display.luhmannId} to another workspace card to connect them`
                      : `Drag ${display.luhmannId} to another card to add [[${display.luhmannId}]]`
                  }
                >
                  {display.luhmannId}
                </span>
              )}
              <h3 className="font-display text-[15px] font-semibold tracking-tight truncate">
                {display.title || (isGhost ? '(untitled temp)' : cardLuhmannId)}
              </h3>
            </div>
            {isIndex && (
              <span className="shrink-0 text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent text-white">
                INDEX
              </span>
            )}
            {isIndex && full && full.autoMembers && full.autoMembers.length > 0 && (
              <span
                className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded bg-accentSoft text-accent border border-accent/20"
                title={`${full.autoMembers.length} cards auto-included via @members directive`}
              >
                +{full.autoMembers.length} auto
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
            // 用户没拖大卡时也允许内容滚（之前是 overflow-hidden 直接裁掉，看不到下半截）
            // nodrag nopan nowheel + capture 阶段拦截，避免 React Flow 把卡内滚轮当成画布缩放
            onWheelCapture={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            className={`nodrag nopan nowheel prose-card text-[12px] text-ink px-5 py-3 overflow-y-auto ${
              h ? 'flex-1' : 'max-h-72'
            }`}
            dangerouslySetInnerHTML={{ __html: html }}
          />

          {variant === 'focus' && !isGhost && backlinks.length > 0 && (
            <div
              className="nodrag nopan nowheel px-5 pb-2 pt-2 border-t border-paperEdge/70 dark:border-[#494d64]"
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onWheelCapture={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setBacklinksOpen((v) => !v);
                }}
                className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-400 hover:text-gray-600 dark:hover:text-[#cad3f5]"
                title={backlinksOpen ? 'Collapse backlinks' : 'Expand backlinks'}
              >
                {backlinksOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                <span>Backlinks · {backlinks.length}</span>
              </button>
              {backlinksOpen && (
                <ul className="mt-1.5 space-y-1 max-h-48 overflow-y-auto pr-1 nowheel">
                  {backlinks.slice(0, 8).map((b) => (
                    <li key={b.sourceId}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(b.sourceId);
                        }}
                        className="w-full text-left p-1.5 rounded hover:bg-gray-50 dark:hover:bg-[#494d64]/40 transition-colors"
                        title={`Open ${b.sourceId}`}
                      >
                        <div className="flex items-baseline gap-1.5">
                          <span className="font-mono text-[10px] font-bold text-accent shrink-0">
                            {b.sourceId}
                          </span>
                          <span className="text-[11px] truncate">{b.sourceTitle || b.sourceId}</span>
                        </div>
                        <div className="text-[10px] text-gray-500 dark:text-[#a5adcb] mt-0.5 line-clamp-2">
                          {b.paragraph}
                        </div>
                      </button>
                    </li>
                  ))}
                  {backlinks.length > 8 && (
                    <li className="text-[10px] text-gray-400 px-1.5">
                      +{backlinks.length - 8} more…
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          {(tags.length > 0 || full) && !isGhost && (
            <footer className="px-5 pb-3 pt-2 border-t border-paperEdge/70 bg-[#fffdf8]/45 dark:bg-white/5 dark:border-[#494d64] space-y-1">
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {tags.slice(0, 6).map((t) => (
                    <button
                      key={t}
                      onClick={(e) => {
                        e.stopPropagation();
                        _openTagTab(t);
                      }}
                      className="text-[9px] font-bold text-accent hover:underline cursor-pointer"
                      title={`Show all cards tagged #${t}`}
                    >
                      #{t}
                    </button>
                  ))}
                </div>
              )}
              {full && (
                <div className="flex items-center gap-2 text-[9px] text-gray-400 tabular-nums">
                  <span title="Words">{countWords(full.contentMd)}w</span>
                  <span className="text-gray-300">·</span>
                  <span title="Outbound [[link]]s">→ {full.crossLinks.length}</span>
                  {(full.updatedAt || full.mtime) && (
                    <>
                      <span className="text-gray-300">·</span>
                      <span title={String(full.updatedAt ?? new Date(full.mtime).toISOString())}>
                        {relativeTime(full.updatedAt ?? full.mtime)}
                      </span>
                    </>
                  )}
                </div>
              )}
            </footer>
          )}
        </>
      )}

      {/* Ghost-from-workspace label */}
      {isGhost && nodeData.ghostFromWorkspace && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            openGhostWorkspace();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="nodrag nopan absolute -bottom-2.5 left-3 px-1.5 py-0.5 rounded text-[9px] font-bold bg-paper border border-accent/30 text-accent shadow-sm flex items-center gap-1 hover:bg-accentSoft hover:border-accent/50"
          title={`Open workspace: ${nodeData.ghostFromWorkspace.workspaceName}`}
        >
          <span className="text-[8px]">⌘</span>
          <span>from workspace</span>
          <span className="text-accent">{nodeData.ghostFromWorkspace.workspaceName}</span>
        </button>
      )}

      {/* Source-box label: this card is borrowed from another box */}
      {!isGhost && showSourceLabel && (
        <div className="absolute -bottom-2.5 left-3 px-1.5 py-0.5 rounded text-[9px] font-bold bg-paper border border-gray-300 text-gray-600 shadow-sm flex items-center gap-1">
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

/**
 * 编辑模式下的"邻近卡都打了这些 tag，你也加？"建议条。
 * 数据来自 /cards/:id/tag-suggestions（基于 tagRelated + potential 聚合）。
 * 已经在 currentTags 里出现的不显示。
 */
function TagSuggestionsRow({
  cardId,
  currentTags,
  onAddTag,
}: {
  cardId: string;
  currentTags: string;
  onAddTag: (name: string) => void;
}) {
  const q = useQuery({
    queryKey: ['tag-suggestions', cardId],
    queryFn: () => api.getTagSuggestions(cardId),
    staleTime: 60_000,
  });
  const usedSet = new Set(
    currentTags
      .split(/[,，\s]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  const items = (q.data?.suggestions ?? []).filter((s) => !usedSet.has(s.name.toLowerCase()));
  if (items.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400">Suggested:</span>
      {items.map((s) => (
        <button
          key={s.name}
          onClick={(e) => {
            e.stopPropagation();
            onAddTag(s.name);
          }}
          className="text-[10px] px-1.5 py-0.5 rounded-full border border-dashed border-accent/50 text-accent hover:bg-accentSoft transition-colors"
          title={`Score ${s.score} from similar cards`}
        >
          + #{s.name}
        </button>
      ))}
    </div>
  );
}
