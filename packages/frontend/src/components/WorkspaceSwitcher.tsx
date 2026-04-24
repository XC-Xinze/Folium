import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Plus, Sparkles } from 'lucide-react';
import { api, type WorkspaceNode } from '../lib/api';
import { dialog } from '../lib/dialog';
import { usePaneStore, type LeafPane, type Pane } from '../store/paneStore';
import { isCardDrag, readCardDragData } from '../lib/dragCard';
import { randomUUID } from '../lib/uuid';

/**
 * 工作区切换器：点击 → 把工作区作为 tab 打开。
 * 拖卡片到切换器 → 如果当前 active tab 是 workspace，加进去；否则提示。
 */
function findLeaf(node: Pane, id: string): LeafPane | null {
  if (node.kind === 'leaf') return node.id === id ? node : null;
  for (const c of node.children) {
    const r = findLeaf(c, id);
    if (r) return r;
  }
  return null;
}

function getActiveWorkspaceTab(): { workspaceId: string; name?: string } | null {
  const { root, activeLeafId } = usePaneStore.getState();
  const leaf = findLeaf(root, activeLeafId);
  if (!leaf) return null;
  const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
  if (tab?.kind === 'workspace' && tab.workspaceId) {
    return { workspaceId: tab.workspaceId, name: tab.title };
  }
  return null;
}

export function WorkspaceSwitcher() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const openTab = usePaneStore((s) => s.openTab);
  // 订阅 root 变化以便重渲染时反映 active workspace
  const root = usePaneStore((s) => s.root);
  const activeLeafId = usePaneStore((s) => s.activeLeafId);
  void root;
  void activeLeafId;
  const activeWs = getActiveWorkspaceTab();

  const wsQ = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces });

  const createMut = useMutation({
    mutationFn: (name: string) => api.createWorkspace(name),
    onSuccess: (ws) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      openTab({ kind: 'workspace', title: ws.name, workspaceId: ws.id });
      setOpen(false);
    },
  });

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const list = wsQ.data?.workspaces ?? [];
  const label = activeWs ? activeWs.name ?? 'Workspace' : 'Open workspace';

  // Drag a card onto the switcher → add to active workspace tab (if any)
  const [dragOver, setDragOver] = useState(false);
  const onDragOver = (e: React.DragEvent) => {
    if (!isCardDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const payload = readCardDragData(e);
    if (!payload) return;
    if (!activeWs) {
      setOpen(true);
      return;
    }
    const ws = await api.getWorkspace(activeWs.workspaceId);
    if (!ws) return;
    if (ws.nodes.some((n) => n.kind === 'card' && n.cardId === payload.luhmannId)) return;
    const newNode: WorkspaceNode = {
      kind: 'card',
      id: randomUUID(),
      cardId: payload.luhmannId,
      x: 200 + Math.random() * 300,
      y: 200 + Math.random() * 200,
    };
    await api.updateWorkspace(activeWs.workspaceId, {
      nodes: [...ws.nodes, newNode],
      edges: ws.edges,
    });
    qc.invalidateQueries({ queryKey: ['workspace', activeWs.workspaceId] });
    qc.invalidateQueries({ queryKey: ['workspaces'] });
  };

  return (
    <div
      className="relative"
      ref={popRef}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] font-bold transition-all ${
          dragOver
            ? 'bg-accent text-white border-accent ring-2 ring-accent/40 scale-105'
            : activeWs
              ? 'bg-accentSoft text-accent border-accent/40'
              : 'bg-white dark:bg-[#1e2030] text-ink dark:text-[#cad3f5] border-gray-200 dark:border-[#363a4f] hover:border-accent/30'
        }`}
        title={activeWs ? 'Active workspace tab · drop a card to add' : 'Open a workspace'}
      >
        <Sparkles size={12} className={activeWs ? 'text-accent' : 'text-gray-400'} />
        <span className="max-w-[160px] truncate">{label}</span>
        <ChevronDown size={11} className="opacity-60" />
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 w-64 bg-white dark:bg-[#1e2030] rounded-lg shadow-xl border border-gray-200 dark:border-[#363a4f] overflow-hidden z-50">
          <div className="max-h-64 overflow-y-auto">
            {list.length === 0 && (
              <div className="text-[11px] text-gray-400 px-3 py-3 italic">No workspaces yet</div>
            )}
            {list.map((ws) => (
              <button
                key={ws.id}
                onClick={() => {
                  openTab({ kind: 'workspace', title: ws.name, workspaceId: ws.id });
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors ${
                  activeWs?.workspaceId === ws.id
                    ? 'bg-accentSoft'
                    : 'hover:bg-gray-50 dark:hover:bg-[#363a4f]'
                }`}
              >
                <span className="text-[12px] truncate">{ws.name}</span>
                <span className="text-[10px] text-gray-400 ml-2 shrink-0">
                  {ws.nodes.length} nodes
                </span>
              </button>
            ))}
          </div>
          <div className="border-t border-gray-100 dark:border-[#363a4f]" />
          <button
            onClick={async () => {
              const name = await dialog.prompt('Workspace name', {
                title: 'New workspace',
                defaultValue: 'New workspace',
                confirmLabel: 'Create',
              });
              if (name?.trim()) createMut.mutate(name.trim());
            }}
            disabled={createMut.isPending}
            className="w-full flex items-center gap-1.5 px-3 py-2 text-[12px] font-bold text-accent hover:bg-accentSoft transition-colors disabled:opacity-50"
          >
            <Plus size={12} />
            New workspace
          </button>
        </div>
      )}
    </div>
  );
}
