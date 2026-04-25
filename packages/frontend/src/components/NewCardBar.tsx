import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image, Paperclip, PenLine, Pencil } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import { usePaneStore } from '../store/paneStore';
import { makeMarkdownInsert, uploadAttachment } from '../lib/uploadAttachment';
import { api } from '../lib/api';

type Status = 'ATOMIC' | 'INDEX';

interface CreateBody {
  luhmannId: string;
  title: string;
  content: string;
  status?: Status;
}

async function createCard(body: CreateBody): Promise<{ luhmannId: string }> {
  const res = await fetch('/api/cards', {
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
}

export function NewCardBar({ onCreated }: NewCardBarProps = {}) {
  const focusedId = useUIStore((s) => s.focusedCardId);
  const focusedBoxId = useUIStore((s) => s.focusedBoxId);
  const qc = useQueryClient();

  const [luhmannId, setLuhmannId] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<Status>('ATOMIC');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [focused, setFocused] = useState(false);
  const [editingId, setEditingId] = useState(false);
  const [tagSuggest, setTagSuggest] = useState<{ query: string; pos: number } | null>(null);
  const [tagSuggestIndex, setTagSuggestIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const idInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['hubs'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      qc.invalidateQueries({ queryKey: ['indexes'] });
      // INDEX cards switch the focused box；ATOMIC 只换 focus（保留当前 box）
      const tabTitle = title.trim() || newId;
      if (status === 'INDEX') {
        usePaneStore.getState().openTab({
          kind: 'card',
          title: tabTitle,
          cardBoxId: newId,
          cardFocusId: newId,
        });
      } else {
        usePaneStore.getState().openTab({
          kind: 'card',
          title: tabTitle,
          cardBoxId: focusedBoxId ?? newId,
          cardFocusId: newId,
        });
      }
      setLuhmannId('');
      setTitle('');
      setContent('');
      setStatus('ATOMIC');
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
        const result = await uploadAttachment(file);
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
      status,
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
    <div className="px-2 pt-2 pb-2 shrink-0">
      <div
        className={`relative w-full bg-paper rounded-2xl transition-all duration-200
          ${focused
            ? 'shadow-paper ring-1 ring-accent/25 border border-accent/30'
            : 'shadow-sm border border-paperEdge hover:border-accent/20 hover:shadow-paper'}
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

        {/* Header label */}
        <div className="flex items-center justify-between pl-7 pr-3 pt-3.5 pb-1">
          <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-accent/80">
            <PenLine size={11} />
            <span>New card</span>
          </div>
        </div>

        {/* Main editor */}
        <div className="pl-7 pr-5 pb-3 relative">
          {/* 显式标题输入；空时 submit 会自动从正文首行推 */}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={() => setFocused(true)}
            placeholder="Title (optional — derived from first line if blank)"
            className="w-full bg-transparent border-0 outline-none text-[16px] font-bold text-ink placeholder:text-gray-300 placeholder:font-normal py-1"
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
            rows={3}
            className="w-full bg-transparent border-0 outline-none resize-none text-[14px] text-ink placeholder:text-gray-300 leading-[1.8]"
            style={{ fontFamily: '"Inter", "Source Han Serif SC", "Songti SC", "Noto Serif SC", serif' }}
          />

          {/* Tag autocomplete popover */}
          {tagSuggest && tagCandidates.length > 0 && (
            <div className="absolute left-7 right-5 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-10">
              <div className="text-[9px] font-black uppercase tracking-widest text-gray-400 px-3 py-1.5 bg-gray-50 border-b border-gray-100">
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
                    i === tagSuggestIndex ? 'bg-accentSoft text-accent' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className="font-bold">#{t.name}</span>
                  <span className="text-[10px] text-gray-400">{t.count} cards</span>
                </button>
              ))}
              <div className="text-[9px] text-gray-400 px-3 py-1 bg-gray-50 border-t border-gray-100">
                ↑↓ navigate · Tab/Enter accept · Esc dismiss
              </div>
            </div>
          )}
        </div>

        {/* Bottom toolbar */}
        <div className="border-t border-paperEdge px-4 py-2 flex items-center gap-1 bg-gradient-to-b from-transparent to-paperEdge/10 rounded-b-2xl">
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
              className="w-24 ml-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-white border border-accent/40 text-ink outline-none"
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
              className="ml-1 flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 hover:bg-accentSoft hover:text-accent transition-colors"
              title={idHint}
            >
              <span className="text-gray-400 font-sans uppercase tracking-widest text-[8px]">id</span>
              <span>{luhmannId || suggestedId}</span>
              <Pencil size={9} className="opacity-50" />
            </button>
          )}

          {ancestorChain.length > 1 && (
            <span className="text-[10px] text-gray-400 ml-2 flex items-center gap-1 truncate">
              <span className="font-bold uppercase tracking-widest text-[8px]">path</span>
              {ancestorChain.map((id, i) => {
                const isLast = i === ancestorChain.length - 1;
                const exists = existingIds.has(id);
                return (
                  <span key={id} className="flex items-center gap-1">
                    {i > 0 && <span className="text-gray-300">›</span>}
                    <span
                      className={`font-mono ${
                        isLast
                          ? 'font-bold text-accent'
                          : exists
                            ? 'text-gray-600'
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
          <span className="text-[10px] text-gray-400 ml-2 hidden md:inline">
            #tag · [[1a]] · drop image
          </span>

          <div className="flex-1" />

          {/* status: Atom / Index */}
          <div className="flex items-center bg-gray-100 rounded-full p-0.5">
            {(['ATOMIC', 'INDEX'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full transition-colors ${
                  status === s
                    ? s === 'INDEX'
                      ? 'bg-accent text-white shadow-sm'
                      : 'bg-white text-ink shadow-sm'
                    : 'text-gray-400 hover:text-ink'
                }`}
              >
                {s === 'ATOMIC' ? 'Atom' : 'Index'}
              </button>
            ))}
          </div>

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
            className="p-1.5 rounded-md text-gray-400 hover:text-accent hover:bg-accentSoft transition-colors"
            title="Insert image"
          >
            <Image size={14} />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-1.5 rounded-md text-gray-400 hover:text-accent hover:bg-accentSoft transition-colors"
            title="Insert attachment"
          >
            <Paperclip size={14} />
          </button>

          {uploading && <span className="text-[10px] text-gray-400 italic ml-1">Uploading…</span>}
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
                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
            }`}
          >
            {mutation.isPending ? 'Saving…' : 'Save'}
            <kbd className="text-[8px] opacity-70 font-mono">⌘↵</kbd>
          </button>
        </div>

        {dragOver && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center rounded-2xl">
            <div className="text-accent font-bold text-sm bg-white/80 px-4 py-2 rounded-full shadow-lg">
              Drop to attach
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
