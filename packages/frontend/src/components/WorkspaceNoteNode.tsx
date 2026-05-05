import { NodeResizer, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { attachMarkdownPostprocessors, attachResourceHandler, renderMarkdown } from '../lib/markdown';
import { applyTextareaEdit, continueMarkdownList, indentMarkdownLines } from '../lib/markdownInput';
import { api } from '../lib/api';

interface NoteNodeData {
  content: string;
  onChange: (content: string) => void;
  onDelete: () => void;
  savedW?: number;
  savedH?: number;
  onResize?: (w: number, h: number) => void;
}

export function WorkspaceNoteNode({ data, selected }: NodeProps) {
  const d = data as unknown as NoteNodeData;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.content);
  const [w, setW] = useState<number | undefined>(d.savedW);
  const [h, setH] = useState<number | undefined>(d.savedH);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && taRef.current) taRef.current.focus();
  }, [editing]);
  useEffect(() => { if (d.savedW != null) setW(d.savedW); }, [d.savedW]);
  useEffect(() => { if (d.savedH != null) setH(d.savedH); }, [d.savedH]);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!contentRef.current || editing) return;
    return attachMarkdownPostprocessors(contentRef.current);
  }, [d.content, editing]);
  useEffect(() => {
    if (!contentRef.current || editing) return;
    return attachResourceHandler(
      contentRef.current,
      (id) => api.getResource(id).catch(() => null),
      (rel) => { void api.openAttachment(rel); },
    );
  }, [d.content, editing]);

  const commit = () => {
    if (draft !== d.content) d.onChange(draft);
    setEditing(false);
  };

  return (
    <div
      className="group relative bg-yellow-50 border border-yellow-300 rounded-lg shadow-md min-h-[120px]"
      style={{ width: w ?? 280, height: h }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={200}
        minHeight={120}
        lineClassName="!border-[#9a6a2f]/40"
        handleClassName="!bg-[#9a6a2f] !border !border-white !w-2 !h-2"
        onResize={(_e, params) => {
          setW(params.width);
          setH(params.height);
        }}
        onResizeEnd={(_e, params) => d.onResize?.(params.width, params.height)}
      />
      <button
        onClick={(e) => {
          e.stopPropagation();
          d.onDelete();
        }}
        className="absolute -top-2 -right-2 z-10 w-6 h-6 rounded-full bg-red-500 text-white shadow-md flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-all"
        title="Delete note"
      >
        <Trash2 size={11} />
      </button>

      {editing ? (
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setDraft(d.content);
              setEditing(false);
              return;
            }
            if (e.key === 'Tab') {
              e.preventDefault();
              applyTextareaEdit(
                e.currentTarget,
                setDraft,
                indentMarkdownLines(
                  e.currentTarget.value,
                  e.currentTarget.selectionStart,
                  e.currentTarget.selectionEnd,
                  e.shiftKey ? 'out' : 'in',
                ),
              );
              return;
            }
            if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) {
              const edit = continueMarkdownList(
                e.currentTarget.value,
                e.currentTarget.selectionStart,
                e.currentTarget.selectionEnd,
              );
              if (edit) {
                e.preventDefault();
                applyTextareaEdit(e.currentTarget, setDraft, edit);
              }
            }
          }}
          className="w-full h-full min-h-[120px] bg-transparent border-0 outline-none p-3 text-[12px] font-mono resize-none nodrag"
          placeholder="Markdown supported…"
        />
      ) : (
        <div
          ref={contentRef}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(d.content);
            setEditing(true);
          }}
          className="prose-card text-[12px] text-ink p-3 cursor-text"
          dangerouslySetInnerHTML={{
            __html: d.content
              ? renderMarkdown(d.content)
              : '<span class="text-gray-400 italic text-[11px]">Double-click to edit…</span>',
          }}
        />
      )}
    </div>
  );
}
