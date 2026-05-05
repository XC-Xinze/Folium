import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check, File, FileAudio, FileText, FileVideo, Image, ExternalLink, Pencil, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type ResourceCard } from '../lib/api';
import { VAULT_BASE } from '../lib/backendUrl';
import { dialog } from '../lib/dialog';
import { isCardDrag, isResourceDrag, readCardDragData, readResourceDragData, setResourceDragData } from '../lib/dragCard';
import { useUIStore } from '../store/uiStore';
import { t } from '../lib/i18n';

export interface ResourceNodeData extends Record<string, unknown> {
  resource: ResourceCard;
  workspaceNodeId?: string;
  onCardLinkDrop?: (sourceLuhmannId: string, resourceId: string) => void | Promise<void>;
  onWorkspaceNodeLinkDrop?: (sourceNodeId: string) => void | Promise<void>;
  onDeleteOverride?: () => void;
}

export const ResourceNode = memo(function ResourceNode({ data }: NodeProps) {
  const { resource, workspaceNodeId, onCardLinkDrop, onWorkspaceNodeLinkDrop, onDeleteOverride } = data as unknown as ResourceNodeData;
  const qc = useQueryClient();
  const language = useUIStore((s) => s.language);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(resource.title);
  const [draftTags, setDraftTags] = useState(resource.tags.join(', '));
  const titleRef = useRef<HTMLInputElement>(null);
  const url = `${VAULT_BASE}/${resource.path}`;
  const Icon = iconForKind(resource.kind);
  useEffect(() => {
    setDraftTitle(resource.title);
    setDraftTags(resource.tags.join(', '));
  }, [resource.id, resource.tags, resource.title]);
  useEffect(() => {
    if (editing) window.setTimeout(() => titleRef.current?.focus(), 20);
  }, [editing]);
  const saveEdit = async () => {
    try {
      await api.updateResource(resource.id, {
        title: draftTitle.trim() || resource.title,
        tags: draftTags.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean),
      });
      await qc.invalidateQueries({ queryKey: ['resources'] });
      await qc.invalidateQueries({ queryKey: ['resources', resource.parentBoxId] });
      await qc.invalidateQueries({ queryKey: ['tags'] });
      setEditing(false);
    } catch (err) {
      await dialog.alert((err as Error).message, { title: t('resource.editFailed', {}, language) });
    }
  };
  const cancelEdit = () => {
    setDraftTitle(resource.title);
    setDraftTags(resource.tags.join(', '));
    setEditing(false);
  };
  return (
    <div
      onDragOver={(e) => {
        if (!isCardDrag(e) && !isResourceDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        if (!isCardDrag(e) && !isResourceDrag(e)) return;
        const dragged = readCardDragData(e);
        const resourceDrag = readResourceDragData(e);
        if (!dragged && !resourceDrag) return;
        e.preventDefault();
        e.stopPropagation();
        if (resourceDrag?.workspaceNodeId && onWorkspaceNodeLinkDrop) {
          if (resourceDrag.workspaceNodeId === workspaceNodeId) return;
          void Promise.resolve(onWorkspaceNodeLinkDrop(resourceDrag.workspaceNodeId)).catch((err) => {
            void dialog.alert((err as Error).message, { title: t('resource.linkFailed', {}, language) });
          });
          return;
        }
        if (dragged?.workspaceNodeId && onWorkspaceNodeLinkDrop) {
          if (dragged.workspaceNodeId === workspaceNodeId) return;
          void Promise.resolve(onWorkspaceNodeLinkDrop(dragged.workspaceNodeId)).catch((err) => {
            void dialog.alert((err as Error).message, { title: t('resource.linkFailed', {}, language) });
          });
          return;
        }
        if (!dragged || !onCardLinkDrop) return;
        void Promise.resolve(onCardLinkDrop(dragged.luhmannId, resource.id)).catch((err) => {
          void dialog.alert((err as Error).message, { title: t('resource.linkFailed', {}, language) });
        });
      }}
      className="group relative w-[260px] overflow-hidden rounded-lg border border-paperEdge bg-white shadow-[0_2px_3px_rgba(45,45,45,0.05),0_16px_36px_rgba(45,45,45,0.11)] dark:border-[#494d64] dark:bg-[#1e2030]"
    >
      <Handle id="top" type="target" position={Position.Top} className="!bg-gray-300 !w-2 !h-2 !border-0" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="!bg-gray-300 !w-2 !h-2 !border-0" />
      <div className="relative aspect-[4/3] bg-[#f3f3f1] dark:bg-[#181926]">
        {resource.kind === 'image' ? (
          <img src={url} alt={resource.title} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted">
            <Icon size={42} strokeWidth={1.6} />
            <span className="text-[10px] font-black uppercase tracking-widest">{resource.kind}</span>
          </div>
        )}
        <div className="absolute left-2 top-2 rounded-full bg-white/85 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-muted shadow-sm backdrop-blur dark:bg-[#1e2030]/85">
          {resource.kind}
        </div>
        <button
          type="button"
          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-muted shadow-sm opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 dark:bg-[#1e2030]/90 dark:text-[#cad3f5]"
          title={t('resource.open', {}, language)}
          onClick={(e) => {
            e.stopPropagation();
            void api.openAttachment(resource.path);
          }}
        >
          <ExternalLink size={13} />
        </button>
        <button
          type="button"
          className="absolute right-10 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-muted shadow-sm opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 dark:bg-[#1e2030]/90 dark:text-[#cad3f5]"
          title={t('resource.edit', {}, language)}
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          <Pencil size={12} />
        </button>
        {onDeleteOverride && (
          <button
            type="button"
            className="absolute right-[72px] top-2 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-red-500 shadow-sm opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 dark:bg-[#1e2030]/90 dark:hover:bg-red-950/30"
            title={t('common.delete', {}, language)}
            onClick={(e) => {
              e.stopPropagation();
              onDeleteOverride();
            }}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      <div className="space-y-2 p-3">
        {!editing && (
          <div
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              setResourceDragData(e, {
                resourceId: resource.id,
                title: resource.title,
                workspaceNodeId,
                workspaceNodeKind: workspaceNodeId ? 'resource' : undefined,
              });
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="nodrag nopan absolute bottom-2 right-2 z-20 px-1.5 py-0.5 rounded flex items-center gap-1 cursor-grab active:cursor-grabbing border shadow-sm transition-colors text-[9px] font-bold uppercase tracking-wider bg-white/90 text-muted opacity-0 group-hover:opacity-100 hover:text-ink dark:bg-[#1e2030]/90"
            title={`Drag to a card to add [[${resource.id}]]`}
          >
            LINK
          </div>
        )}
        {editing ? (
          <div className="nodrag nopan space-y-2" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <Icon size={14} className="shrink-0 text-accent" />
              <input
                ref={titleRef}
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') cancelEdit();
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    void saveEdit();
                  }
                }}
                className="min-w-0 flex-1 rounded border border-paperEdge bg-white px-2 py-1 text-[12px] font-bold outline-none focus:border-accent dark:border-[#494d64] dark:bg-[#24273a] dark:text-[#cad3f5]"
              />
            </div>
            <input
              value={draftTags}
              onChange={(e) => setDraftTags(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancelEdit();
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault();
                  void saveEdit();
                }
              }}
              placeholder={t('resource.tagsPlaceholder', {}, language)}
              className="w-full rounded border border-paperEdge bg-white px-2 py-1 text-[11px] outline-none focus:border-accent dark:border-[#494d64] dark:bg-[#24273a] dark:text-[#cad3f5]"
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={cancelEdit}
                className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-bold text-muted hover:bg-gray-100 dark:hover:bg-[#363a4f]"
              >
                <X size={10} /> {t('common.cancel', {}, language)}
              </button>
              <button
                type="button"
                onClick={() => void saveEdit()}
                className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[10px] font-bold text-white hover:bg-accent/90"
              >
                <Check size={10} /> {t('common.save', {}, language)}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <Icon size={14} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-bold text-ink dark:text-[#cad3f5]">{resource.title}</div>
                <div className="truncate font-mono text-[10px] text-muted">{resource.id}</div>
              </div>
            </div>
            <div className="min-h-[20px]">
              {resource.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {resource.tags.slice(0, 8).map((tag) => (
                    <span key={tag} className="rounded-full bg-accentSoft px-2 py-0.5 text-[10px] font-semibold text-accent">
                      #{tag}
                    </span>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="text-[10px] font-semibold text-muted hover:text-accent"
                >
                  {t('resource.addTags', {}, language)}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
});

function iconForKind(kind: ResourceCard['kind']) {
  if (kind === 'image') return Image;
  if (kind === 'pdf') return FileText;
  if (kind === 'audio') return FileAudio;
  if (kind === 'video') return FileVideo;
  return File;
}
