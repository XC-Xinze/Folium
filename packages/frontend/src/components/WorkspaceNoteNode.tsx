import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { renderMarkdown } from '../lib/markdown';

interface NoteNodeData {
  content: string;
  onChange: (content: string) => void;
  onDelete: () => void;
}

export function WorkspaceNoteNode({ data }: NodeProps) {
  const d = data as unknown as NoteNodeData;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.content);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && taRef.current) taRef.current.focus();
  }, [editing]);

  const commit = () => {
    if (draft !== d.content) d.onChange(draft);
    setEditing(false);
  };

  return (
    <div className="group relative bg-yellow-50 border border-yellow-300 rounded-lg shadow-md w-[280px] min-h-[120px]">
      <Handle id="top" type="target" position={Position.Top} className="!bg-yellow-400 !w-2 !h-2 !border-0" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="!bg-yellow-400 !w-2 !h-2 !border-0" />
      <Handle id="left-in" type="target" position={Position.Left} className="!bg-transparent !w-2 !h-2 !border-0" />
      <Handle id="left-out" type="source" position={Position.Left} className="!bg-transparent !w-2 !h-2 !border-0" />
      <Handle id="right-in" type="target" position={Position.Right} className="!bg-transparent !w-2 !h-2 !border-0" />
      <Handle id="right-out" type="source" position={Position.Right} className="!bg-transparent !w-2 !h-2 !border-0" />

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
            }
          }}
          className="w-full h-full min-h-[120px] bg-transparent border-0 outline-none p-3 text-[12px] font-mono resize-none nodrag"
          placeholder="Markdown supported…"
        />
      ) : (
        <div
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
