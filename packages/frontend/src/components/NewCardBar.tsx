import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image, Paperclip, PenLine, Pencil } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import { usePaneStore } from '../store/paneStore';
import { makeMarkdownInsert, uploadAttachment } from '../lib/uploadAttachment';
import { api } from '../lib/api';
import { API_BASE } from '../lib/backendUrl';

// status 是 derived from structure（有 Folgezettel 子卡 = INDEX），用户不再手动选
interface CreateBody {
  luhmannId: string;
  title: string;
  content: string;
}

async function createCard(body: CreateBody): Promise<{ luhmannId: string }> {
  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.message ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function deriveTitle(content: string): string {
  const firstLine = content.split('\n').find((l) => l.trim()) ?? '';
  return firstLine
    .replace(/^#+\s*/, '')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    // strip #tag tokens (CJK + word chars)
    .replace(/#[\p{L}\w-]+/gu, '')
    .trim()
    .slice(0, 80);
}

function deriveParentId(luhmannId: string): string | null {
  if (luhmannId.length <= 1) return null;
  const lastChar = luhmannId.at(-1)!;
  const isLastDigit = /\d/.test(lastChar);
  for (let i = luhmannId.length - 2; i >= 0; i--) {
    const ch = luhmannId[i]!;
    const isDigit = /\d/.test(ch);
    if (isDigit !== isLastDigit) return luhmannId.slice(0, i + 1);
  }
  return null;
}

function rootId(luhmannId: string): string {
  let cur = luhmannId;
  for (;;) {
    const parent = deriveParentId(cur);
    if (!parent) return cur;
    cur = parent;
  }
}

function isInBox(luhmannId: string, boxId: string): boolean {
  let cur: string | null = luhmannId;
  while (cur) {
    if (cur === boxId) return true;
    cur = deriveParentId(cur);
  }
  return false;
}

function nearestExistingAncestorOrSelf(luhmannId: string, existing: Set<string>): string {
  let cur: string | null = luhmannId;
  while (cur) {
    if (cur === luhmannId || existing.has(cur)) return cur;
    cur = deriveParentId(cur);
  }
  return luhmannId;
}

/**
 * 推算"父卡片下一个未占用的子卡 id"。
 *   1a (末尾 alpha) → 1a1, 1a2, 1a3...
 *   1 (末尾 num)    → 1a, 1b, 1c...
 *   1a2 (末尾 num)  → 1a2a, 1a2b...
 */
/** Folgezettel 父：剥掉末尾连续的同类（数字 / 字母）一段
 *   1c → 1, 1c2 → 1c, 1c2b → 1c2, 1 → null
 *   非纯字母数字（如 daily20260424）→ null */
function parentOfId(id: string): string | null {
  if (!id || !/^[\da-z]+$/i.test(id)) return null;
  if (/\d$/.test(id)) {
    const p = id.replace(/\d+$/, '');
    return p || null;
  }
  if (/[a-z]$/i.test(id)) {
    const p = id.replace(/[a-z]+$/i, '');
    return p || null;
  }
  return null;
}

function nextChildId(parentId: string, existing: Set<string>): string {
  if (!parentId) return nextTopLevelId(existing);
  const lastIsNum = /\d$/.test(parentId);
  if (lastIsNum) {
    for (let i = 0; i < 26; i++) {
      const c = parentId + String.fromCharCode(97 + i);
      if (!existing.has(c)) return c;
    }
    return parentId + 'aa';
  }
  for (let i = 1; i < 1000; i++) {
    const c = parentId + i;
    if (!existing.has(c)) return c;
  }
  return parentId + '1';
}

function nextTopLevelId(existing: Set<string>): string {
  let n = 1;
  while (existing.has(String(n))) n++;
  return String(n);
}

interface NewCardBarProps {
  /** 创建成功后回调（一般用于关闭包它的 modal） */
  onCreated?: () => void;
  variant?: 'inline' | 'modal';
}

export function NewCardBar({ onCreated, variant = 'inline' }: NewCardBarProps = {}) {
  const focusedId = useUIStore((s) => s.focusedCardId);
  const focusedBoxId = useUIStore((s) => s.focusedBoxId);
  const storedNewCardDraft = useUIStore((s) => s.newCardDraft);
  const newCardDraft = variant === 'modal' ? storedNewCardDraft : null;
  const qc = useQueryClient();

  const [luhmannId, setLuhmannId] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [focused, setFocused] = useState(false);
  const [editingId, setEditingId] = useState(false);
  const [tagSuggest, setTagSuggest] = useState<{ query: string; pos: number } | null>(null);
  const [tagSuggestIndex, setTagSuggestIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const idInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftKey = `${newCardDraft?.luhmannId ?? ''}\n${newCardDraft?.title ?? ''}\n${newCardDraft?.content ?? ''}`;

  const tagsQ = useQuery({ queryKey: ['tags'], queryFn: api.listTags });
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });

  // 根据当前焦点和已有卡片推算下一个 id
  // 焦点存在 → 当作父级，找下一个空的 child；否则给一个新顶层
  const suggestedId = useMemo(() => {
    const existing = new Set((cardsQ.data?.cards ?? []).map((c) => c.luhmannId));
    return focusedId ? nextChildId(focusedId, existing) : nextTopLevelId(existing);
  }, [cardsQ.data, focusedId]);

  // 用户没手动改过 id 时，让 luhmannId 跟随推算结果
  useEffect(() => {
    if (!editingId) setLuhmannId(suggestedId);
  }, [suggestedId, editingId]);

  useEffect(() => {
    if (!newCardDraft) return;
    if (newCardDraft.luhmannId) {
      setLuhmannId(newCardDraft.luhmannId);
      setEditingId(true);
    }
    if (newCardDraft.title !== undefined) setTitle(newCardDraft.title);
    if (newCardDraft.content !== undefined) setContent(newCardDraft.content);
  }, [draftKey, newCardDraft]);

  // Tag autocomplete candidates
  const tagCandidates = (() => {
    if (!tagSuggest) return [];
    const q = tagSuggest.query.toLowerCase();
    const all = tagsQ.data?.tags ?? [];
    return all
      .filter((t) => t.name.toLowerCase().startsWith(q) && t.name.toLowerCase() !== q)
      .slice(0, 6);
  })();

  // Watch content changes to detect #xxx being typed
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || !focused) {
      setTagSuggest(null);
      return;
    }
    const cursor = ta.selectionStart;
    const before = content.slice(0, cursor);
    // Find the most recent # (must be at line-start or preceded by whitespace)
    const m = before.match(/(?:^|\s)#([\p{L}\w-]*)$/u);
    if (m && m[1] !== undefined) {
      const queryStart = cursor - m[1].length;
      setTagSuggest({ query: m[1], pos: queryStart });
      setTagSuggestIndex(0);
    } else {
      setTagSuggest(null);
    }
  }, [content, focused]);

  const acceptTagSuggestion = (tag: string) => {
    if (!tagSuggest) return;
    const before = content.slice(0, tagSuggest.pos);
    const after = content.slice(tagSuggest.pos + tagSuggest.query.length);
    const next = before + tag + (after.startsWith(' ') ? '' : ' ') + after;
    setContent(next);
    setTagSuggest(null);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        const newPos = before.length + tag.length + 1;
        ta.selectionStart = ta.selectionEnd = newPos;
      }
    });
  };

  const mutation = useMutation({
    mutationFn: createCard,
    onSuccess: ({ luhmannId: newId }) => {
      // 新卡只有确实属于当前 box 的 Folgezettel 子树时才留在当前 box。
      // 例如：在 2 里手动创建 3 或 3a，都要先切到 3/3a 的上下文，
      // 再刷新 cards，避免新卡在旧 box 里闪现一帧。
      const tabTitle = title.trim() || newId;
      const existing = new Set((cardsQ.data?.cards ?? []).map((c) => c.luhmannId));
      existing.add(newId);
      const nextBoxId =
        focusedBoxId && isInBox(newId, focusedBoxId)
          ? focusedBoxId
          : nearestExistingAncestorOrSelf(newId, existing);
      usePaneStore.getState().openTab({
        kind: 'card',
        title: tabTitle,
        cardBoxId: nextBoxId,
        cardFocusId: newId,
      });
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['hubs'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      qc.invalidateQueries({ queryKey: ['indexes'] });
      setLuhmannId('');
      setTitle('');
      setContent('');
      setEditingId(false); // 重新交还给自动推算
      onCreated?.();
    },
  });

  const insertAtCursor = (text: string) => {
    const ta = taRef.current;
    if (!ta) {
      setContent((c) => c + text);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = content.slice(0, start) + text + content.slice(end);
    setContent(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + text.length;
    });
  };

  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        // 当前焦点 box 给后端，per-box 模式下落到子目录
        const result = await uploadAttachment(file, focusedBoxId);
        insertAtCursor('\n' + makeMarkdownInsert(result) + '\n');
      }
    } finally {
      setUploading(false);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void handleFiles(files);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    void handleFiles(e.dataTransfer?.files ?? null);
  };

  const submit = () => {
    if (!luhmannId.trim() || !content.trim()) return;
    // 优先用显式标题；空时回退到 content 第一行；都没有就给个兜底
    const finalTitle =
      title.trim() || deriveTitle(content) || `Card ${luhmannId.trim()}`;
    mutation.mutate({
      luhmannId: luhmannId.trim(),
      title: finalTitle,
      content,
    });
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (tagSuggest && tagCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setTagSuggestIndex((i) => (i + 1) % tagCandidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setTagSuggestIndex((i) => (i - 1 + tagCandidates.length) % tagCandidates.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !(e.metaKey || e.ctrlKey))) {
        const pick = tagCandidates[tagSuggestIndex];
        if (pick) {
          e.preventDefault();
          acceptTagSuggestion(pick.name);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setTagSuggest(null);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  const canSave = luhmannId.trim() && content.trim() && !mutation.isPending;
  const isModal = variant === 'modal';
  // 推算依据的人话提示，给底部 id 标签当 tooltip
  const idHint = focusedId
    ? `Auto-suggested as a child of ${focusedId}. Click to override.`
    : 'Auto-suggested as a new top-level card. Click to override.';

  // 计算 luhmannId 的祖先链 —— 给用户看"这张卡是谁的孩子"
  const ancestorChain = useMemo(() => {
    if (!luhmannId.trim()) return [] as string[];
    const chain: string[] = [];
    let cur = luhmannId.trim();
    chain.unshift(cur);
    while (true) {
      const p = parentOfId(cur);
      if (!p) break;
      chain.unshift(p);
      cur = p;
      if (chain.length > 10) break; // 防意外
    }
    return chain;
  }, [luhmannId]);
  const existingIds = useMemo(
    () => new Set((cardsQ.data?.cards ?? []).map((c) => c.luhmannId)),
    [cardsQ.data],
  );

  return (
    <div className={`${isModal ? 'px-5 pt-4 pb-5' : 'px-2 pt-2 pb-2'} shrink-0`}>
      <div
        className={`relative w-full zk-paper-surface rounded-lg transition-all duration-200 overflow-hidden
          ${focused
            ? 'ring-1 ring-accent/25 border border-accent/35'
            : 'border border-paperEdge hover:border-accent/25'}
          ${dragOver ? 'ring-2 ring-accent border-accent bg-accentSoft/40' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {/* Left accent bar */}
        <div className="absolute left-0 top-4 bottom-4 w-[3px] bg-accent rounded-full" />
        <div className="absolute inset-x-0 top-0 h-px bg-white/70 dark:bg-white/10 pointer-events-none" />

        {/* Header label */}
        <div className={`flex items-center justify-between pl-7 pr-4 ${isModal ? 'pt-4 pb-2' : 'pt-3.5 pb-1'}`}>
          <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-accent">
            <PenLine size={11} />
            <span>{isModal ? 'Draft card' : 'New card'}</span>
          </div>
          <div className="hidden sm:flex items-center gap-2 text-[10px] text-muted">
            <span className="font-mono">{luhmannId || suggestedId}</span>
            <span className="h-1 w-1 rounded-full bg-paperEdge" />
            <span>{focusedId ? `child of ${focusedId}` : 'top level'}</span>
          </div>
        </div>

        {/* Main editor */}
        <div className={`pl-7 pr-5 ${isModal ? 'pb-5' : 'pb-3'} relative`}>
          {/* 显式标题输入；空时 submit 会自动从正文首行推 */}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={() => setFocused(true)}
            placeholder="Title (optional — derived from first line if blank)"
            className={`w-full bg-transparent border-0 outline-none font-display font-semibold text-ink placeholder:text-gray-300 dark:placeholder:text-[#6e738d] placeholder:font-normal py-1 ${
              isModal ? 'text-[24px] leading-tight' : 'text-[17px] leading-tight'
            }`}
          />
          <textarea
            ref={taRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            placeholder="What's on your mind?"
            rows={isModal ? 7 : 3}
            className={`w-full bg-transparent border-0 outline-none resize-none text-ink placeholder:text-gray-300 dark:placeholder:text-[#6e738d] leading-[1.75] ${
              isModal ? 'text-[15px] mt-2' : 'text-[14px]'
            }`}
            style={{ fontFamily: 'var(--font-body), Inter, system-ui, sans-serif' }}
          />

          {/* Tag autocomplete popover */}
          {tagSuggest && tagCandidates.length > 0 && (
            <div className="absolute left-7 right-5 mt-1 zk-paper-surface border border-paperEdge rounded-lg shadow-paper overflow-hidden z-10">
              <div className="text-[9px] font-black uppercase tracking-widest text-muted px-3 py-1.5 bg-paperWarm/70 border-b border-paperEdge">
                Tag · {tagCandidates.length}
              </div>
              {tagCandidates.map((t, i) => (
                <button
                  key={t.name}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptTagSuggestion(t.name);
                  }}
                  className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center justify-between transition-colors ${
                    i === tagSuggestIndex ? 'bg-accentSoft text-accent' : 'hover:bg-surfaceAlt text-ink'
                  }`}
                >
                  <span className="font-bold">#{t.name}</span>
                  <span className="text-[10px] text-muted">{t.count} cards</span>
                </button>
              ))}
              <div className="text-[9px] text-muted px-3 py-1 bg-paperWarm/70 border-t border-paperEdge">
                ↑↓ navigate · Tab/Enter accept · Esc dismiss
              </div>
            </div>
          )}
        </div>

        {/* Bottom toolbar */}
        <div className="border-t border-paperEdge px-4 py-2 flex items-center gap-1 bg-gradient-to-b from-transparent to-paperEdge/10">
          {/* "Save as: 1aa" 标签——明示自动推算的 id，点击可手改 */}
          {editingId ? (
            <input
              ref={idInputRef}
              value={luhmannId}
              onChange={(e) => setLuhmannId(e.target.value)}
              onBlur={() => {
                if (!luhmannId.trim()) {
                  setLuhmannId(suggestedId);
                  setEditingId(false);
                } else if (luhmannId === suggestedId) {
                  setEditingId(false);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  e.preventDefault();
                  if (e.key === 'Escape') {
                    setLuhmannId(suggestedId);
                    setEditingId(false);
                  } else {
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }
              }}
              autoFocus
              className="w-24 ml-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-paper border border-accent/40 text-ink outline-none"
              title={idHint}
            />
          ) : (
            <button
              onClick={() => {
                setEditingId(true);
                requestAnimationFrame(() => {
                  idInputRef.current?.select();
                });
              }}
              className="ml-1 flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-paperWarm border border-paperEdge/70 text-muted hover:bg-accentSoft hover:text-accent hover:border-accent/30 transition-colors"
              title={idHint}
            >
              <span className="text-muted font-sans uppercase tracking-widest text-[8px]">id</span>
              <span>{luhmannId || suggestedId}</span>
              <Pencil size={9} className="opacity-50" />
            </button>
          )}

          {ancestorChain.length > 1 && (
            <span className="text-[10px] text-muted ml-2 flex items-center gap-1 truncate">
              <span className="font-bold uppercase tracking-widest text-[8px]">path</span>
              {ancestorChain.map((id, i) => {
                const isLast = i === ancestorChain.length - 1;
                const exists = existingIds.has(id);
                return (
                  <span key={id} className="flex items-center gap-1">
                    {i > 0 && <span className="text-paperEdge">›</span>}
                    <span
                      className={`font-mono ${
                        isLast
                            ? 'font-bold text-accent'
                            : exists
                            ? 'text-muted'
                            : 'text-red-400 line-through'
                      }`}
                      title={exists ? `${id} exists` : `${id} doesn't exist yet`}
                    >
                      {id}
                    </span>
                  </span>
                );
              })}
            </span>
          )}
          <span className="text-[10px] text-muted ml-2 hidden md:inline">
            #tag · [[1a]] · drop image
          </span>

          <div className="flex-1" />

          {/* status 是 derived（有子卡 = INDEX），不再让用户选 */}

          {/* Attachments */}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="image/*,.pdf,.zip,.txt,.md"
            multiple
            onChange={(e) => {
              void handleFiles(e.target.files);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-1.5 rounded-md text-muted hover:text-accent hover:bg-accentSoft transition-colors"
            title="Insert image"
          >
            <Image size={14} />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-1.5 rounded-md text-muted hover:text-accent hover:bg-accentSoft transition-colors"
            title="Insert attachment"
          >
            <Paperclip size={14} />
          </button>

          {uploading && <span className="text-[10px] text-muted italic ml-1">Uploading…</span>}
          {mutation.isError && (
            <span className="text-[10px] text-red-500/80 ml-1 max-w-[180px] truncate">
              {(mutation.error as Error).message}
            </span>
          )}

          {/* Save button */}
          <button
            onClick={submit}
            disabled={!canSave}
            className={`ml-1 flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[11px] font-bold tracking-wide transition-all ${
              canSave
                ? 'bg-accent text-white hover:bg-accent/90 shadow-md hover:shadow-lg active:scale-95'
                : 'bg-paperWarm border border-paperEdge text-muted cursor-not-allowed'
            }`}
          >
            {mutation.isPending ? 'Saving…' : 'Save'}
            <kbd className="text-[8px] opacity-70 font-mono">⌘↵</kbd>
          </button>
        </div>

        {dragOver && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center rounded-lg bg-accentSoft/25 backdrop-blur-[1px]">
            <div className="text-accent font-bold text-sm bg-paper/90 border border-accent/25 px-4 py-2 rounded-full shadow-paper">
              Drop to attach
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
