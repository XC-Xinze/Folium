import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, Link2, Trash2 } from 'lucide-react';
import { renderMarkdown } from '../lib/markdown';
import { isCardDrag, readCardDragData, setCardDragData } from '../lib/dragCard';

interface TempNodeData {
  title: string;
  content: string;
  onChange: (patch: { title?: string; content?: string }) => void;
  onDelete: () => void;
  onPromoteToVault: () => void;
  /** 跟 CardNode 一致：拖一张实体卡 drop 到本 temp → 创建 workspace edge */
  onCardLinkDrop?: (sourceLuhmannId: string) => void;
  onWorkspaceNodeLinkDrop?: (sourceNodeId: string) => void;
  workspaceNodeId: string;
  savedW?: number;
  savedH?: number;
  onResize?: (w: number, h: number) => void;
}

export function WorkspaceTempNode({ data, selected }: NodeProps) {
  const d = data as unknown as TempNodeData;
  const [editing, setEditing] = useState(false);
  const [linkDropOver, setLinkDropOver] = useState(false);
  const [draftTitle, setDraftTitle] = useState(d.title);
  const [draftContent, setDraftContent] = useState(d.content);
  const [w, setW] = useState<number | undefined>(d.savedW);
  const [h, setH] = useState<number | undefined>(d.savedH);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && taRef.current) taRef.current.focus();
  }, [editing]);
  useEffect(() => { if (d.savedW != null) setW(d.savedW); }, [d.savedW]);
  useEffect(() => { if (d.savedH != null) setH(d.savedH); }, [d.savedH]);

  const commit = () => {
    const patch: { title?: string; content?: string } = {};
    if (draftTitle !== d.title) patch.title = draftTitle;
    if (draftContent !== d.content) patch.content = draftContent;
    if (Object.keys(patch).length > 0) d.onChange(patch);
    setEditing(false);
  };

  return (
    <div
      onDragOver={(e) => {
        if (!isCardDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        setLinkDropOver(true);
      }}
      onDragLeave={() => setLinkDropOver(false)}
      onDrop={(e) => {
        setLinkDropOver(false);
        if (!isCardDrag(e)) return;
        const dragged = readCardDragData(e);
        if (!dragged) return;
        e.preventDefault();
        e.stopPropagation();
        if (dragged.workspaceNodeId && d.onWorkspaceNodeLinkDrop) {
          d.onWorkspaceNodeLinkDrop(dragged.workspaceNodeId);
          return;
        }
        d.onCardLinkDrop?.(dragged.luhmannId);
      }}
      className={`group relative bg-[#fffdf8] border-2 border-dashed border-accent/40 rounded-lg shadow-md min-h-[140px] ${
        linkDropOver ? 'ring-2 ring-accent ring-offset-2' : ''
      }`}
      style={{ width: w ?? 300, height: h }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={220}
        minHeight={140}
        lineClassName="!border-accent/40"
        handleClassName="!bg-accent !border !border-white !w-2 !h-2"
        onResize={(_e, params) => {
          setW(params.width);
          setH(params.height);
        }}
        onResizeEnd={(_e, params) => d.onResize?.(params.width, params.height)}
      />
      <Handle id="top" type="target" position={Position.Top} className="!bg-accent !w-2 !h-2 !border-0" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="!bg-accent !w-2 !h-2 !border-0" />
      <Handle id="left-in" type="target" position={Position.Left} className="!bg-transparent !w-2 !h-2 !border-0" />
      <Handle id="left-out" type="source" position={Position.Left} className="!bg-transparent !w-2 !h-2 !border-0" />
      <Handle id="right-in" type="target" position={Position.Right} className="!bg-transparent !w-2 !h-2 !border-0" />
      <Handle id="right-out" type="source" position={Position.Right} className="!bg-transparent !w-2 !h-2 !border-0" />

      <span className="absolute top-2 right-3 text-[8px] font-bold uppercase tracking-widest text-accent">
        Temp
      </span>

      <button
        onClick={(e) => {
          e.stopPropagation();
          d.onDelete();
        }}
        className="absolute -top-2 -right-2 z-10 w-6 h-6 rounded-full bg-red-500 text-white shadow-md flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-all"
        title="Delete temp card"
      >
        <Trash2 size={11} />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          d.onPromoteToVault();
        }}
        className="absolute -top-2 -left-2 z-10 w-6 h-6 rounded-full bg-emerald-500 text-white shadow-md flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-emerald-600 transition-all"
        title="Promote to a real vault card"
      >
        <ArrowUpCircle size={12} />
      </button>
      {!editing && (
        <div
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            setCardDragData(e, {
              luhmannId: d.workspaceNodeId,
              title: d.title,
              workspaceNodeId: d.workspaceNodeId,
              workspaceNodeKind: 'temp',
            });
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag nopan zk-subtle-button absolute bottom-2 right-2 z-20 px-1.5 py-0.5 rounded flex items-center gap-1 cursor-grab active:cursor-grabbing border shadow-sm transition-colors text-[9px] font-bold uppercase tracking-wider"
          title="Drag onto another workspace card to link them"
        >
          <Link2 size={10} />
          <span>LINK</span>
        </div>
      )}

      {editing ? (
        <div
          className="p-3 space-y-2"
          onBlur={(e) => {
            // Don't commit when focus moves between fields inside this editor
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            commit();
          }}
        >
          <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDraftTitle(d.title);
                setDraftContent(d.content);
                setEditing(false);
              }
            }}
            placeholder="Title"
            className="w-full text-sm font-bold bg-transparent border-b border-gray-200 outline-none nodrag"
          />
          <textarea
            ref={taRef}
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDraftTitle(d.title);
                setDraftContent(d.content);
                setEditing(false);
              }
            }}
            placeholder="Markdown body…"
            className="w-full min-h-[80px] text-[12px] font-mono bg-transparent border-0 outline-none resize-none nodrag"
          />
        </div>
      ) : (
        <div
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraftTitle(d.title);
            setDraftContent(d.content);
            setEditing(true);
          }}
          className="p-3 cursor-text"
        >
          <div className="text-sm font-bold mb-1">{d.title || <span className="text-gray-400 italic text-xs">Untitled</span>}</div>
          <div
            className="prose-card text-[12px] text-ink/90"
            dangerouslySetInnerHTML={{
              __html: d.content
                ? renderMarkdown(d.content)
                : '<span class="text-gray-400 italic text-[11px]">Double-click to edit…</span>',
            }}
          />
        </div>
      )}
    </div>
  );
}
