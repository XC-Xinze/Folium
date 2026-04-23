import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image, Paperclip, PenLine } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
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
    .replace(/#[一-龥\w-]+/g, '')
    .trim()
    .slice(0, 80);
}

export function NewCardBar() {
  const focusedId = useUIStore((s) => s.focusedCardId);
  const setBoxAndFocus = useUIStore((s) => s.setBoxAndFocus);
  const setFocus = useUIStore((s) => s.setFocus);
  const qc = useQueryClient();

  const [luhmannId, setLuhmannId] = useState('');
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<Status>('ATOMIC');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tagSuggest, setTagSuggest] = useState<{ query: string; pos: number } | null>(null);
  const [tagSuggestIndex, setTagSuggestIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tagsQ = useQuery({ queryKey: ['tags'], queryFn: api.listTags });

  // tag 自动补全候选
  const tagCandidates = (() => {
    if (!tagSuggest) return [];
    const q = tagSuggest.query.toLowerCase();
    const all = tagsQ.data?.tags ?? [];
    return all
      .filter((t) => t.name.toLowerCase().startsWith(q) && t.name.toLowerCase() !== q)
      .slice(0, 6);
  })();

  // 监听内容变化，检测是否在输入 #xxx
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || !focused) {
      setTagSuggest(null);
      return;
    }
    const cursor = ta.selectionStart;
    const before = content.slice(0, cursor);
    // 找最近的 # 起始位置（要求前面是空白或行首）
    const m = before.match(/(?:^|\s)#([一-龥\w-]*)$/);
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
      // 创建 INDEX 卡 → 同时切换 box；ATOMIC → 仅 focus
      if (status === 'INDEX') setBoxAndFocus(newId);
      else setFocus(newId);
      setLuhmannId('');
      setContent('');
      setStatus('ATOMIC');
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
    const title = deriveTitle(content) || `Card ${luhmannId.trim()}`;
    mutation.mutate({
      luhmannId: luhmannId.trim(),
      title,
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

  const fillFromFocus = () => {
    if (!focusedId) return;
    setLuhmannId(focusedId + 'a');
  };

  const canSave = luhmannId.trim() && content.trim() && !mutation.isPending;

  return (
    <div className="px-6 pt-5 pb-4">
      <div
        className={`relative max-w-3xl mx-auto bg-paper rounded-2xl transition-all duration-200
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
        {/* 左侧装饰条：紫色窄竖线，给输入框一个视觉锚点 */}
        <div className="absolute left-0 top-4 bottom-4 w-[3px] bg-accent rounded-full" />

        {/* 顶部小标签：带图标，告诉用户这是个写作区 */}
        <div className="flex items-center justify-between pl-7 pr-5 pt-3.5 pb-1">
          <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-accent/80">
            <PenLine size={11} />
            <span>新卡片</span>
          </div>
          <div className="flex items-center gap-2">
            {/* L-Index：右上角，小但可见 */}
            <input
              value={luhmannId}
              onChange={(e) => setLuhmannId(e.target.value)}
              placeholder="编号"
              className="w-20 bg-transparent border-0 outline-none text-[11px] font-mono font-bold text-ink placeholder:text-gray-300 text-right focus:bg-white/60 px-1.5 py-0.5 rounded transition-colors"
            />
            {focusedId && !luhmannId && (
              <button
                onClick={fillFromFocus}
                className="text-[10px] text-gray-400 hover:text-accent transition-colors"
                title={`基于焦点 ${focusedId}`}
              >
                ↳ {focusedId}a
              </button>
            )}
          </div>
        </div>

        {/* 主输入区 */}
        <div className="pl-7 pr-5 pb-3 relative">
          <textarea
            ref={taRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            placeholder="此刻在想什么？"
            rows={3}
            className="w-full bg-transparent border-0 outline-none resize-none text-[14px] text-ink placeholder:text-gray-300 leading-[1.8]"
            style={{ fontFamily: '"Source Han Serif SC", "Songti SC", "Noto Serif SC", "Inter", serif' }}
          />

          {/* tag 自动补全弹层 */}
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
                  <span className="text-[10px] text-gray-400">{t.count} 张</span>
                </button>
              ))}
              <div className="text-[9px] text-gray-400 px-3 py-1 bg-gray-50 border-t border-gray-100">
                ↑↓ 选择 · Tab/Enter 确认 · Esc 关闭
              </div>
            </div>
          )}
        </div>

        {/* 底部工具条：细线分隔，纸面色加深一点 */}
        <div className="border-t border-paperEdge px-4 py-2 flex items-center gap-1 bg-gradient-to-b from-transparent to-paperEdge/10 rounded-b-2xl">
          {/* 提示语：极弱 */}
          <span className="text-[10px] text-gray-400 ml-2 hidden sm:inline">
            #标签 · [[1a]] · 拖拽图片
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

          {/* 附件 */}
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
            title="插入图片"
          >
            <Image size={14} />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-1.5 rounded-md text-gray-400 hover:text-accent hover:bg-accentSoft transition-colors"
            title="插入附件"
          >
            <Paperclip size={14} />
          </button>

          {uploading && <span className="text-[10px] text-gray-400 italic ml-1">上传中…</span>}
          {mutation.isError && (
            <span className="text-[10px] text-red-500/80 ml-1 max-w-[180px] truncate">
              {(mutation.error as Error).message}
            </span>
          )}

          {/* 保存按钮：紫色胶囊 */}
          <button
            onClick={submit}
            disabled={!canSave}
            className={`ml-1 flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[11px] font-bold tracking-wide transition-all ${
              canSave
                ? 'bg-accent text-white hover:bg-accent/90 shadow-md hover:shadow-lg active:scale-95'
                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
            }`}
          >
            {mutation.isPending ? '记录中' : '记录'}
            <kbd className="text-[8px] opacity-70 font-mono">⌘↵</kbd>
          </button>
        </div>

        {dragOver && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center rounded-2xl">
            <div className="text-accent font-bold text-sm bg-white/80 px-4 py-2 rounded-full shadow-lg">
              松手插入附件
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
