import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Plus, Sparkles } from 'lucide-react';
import { api, type WorkspaceNode } from '../lib/api';
import { useUIStore } from '../store/uiStore';
import { isCardDrag, readCardDragData } from '../lib/dragCard';
import { randomUUID } from '../lib/uuid';

/**
 * 主区顶部的 workspace 快速切换器 —— 总是可见，不需要滚 sidebar。
 *   - 显示当前 workspace 名（或 "Vault"）
 *   - 点击展开下拉，列出所有 + 新建
 */
export function WorkspaceSwitcher() {
  const focusedWorkspaceId = useUIStore((s) => s.focusedWorkspaceId);
  const setFocusWorkspace = useUIStore((s) => s.setFocusWorkspace);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  const wsQ = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces });

  const createMut = useMutation({
    mutationFn: (name: string) => api.createWorkspace(name),
    onSuccess: (ws) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      setFocusWorkspace(ws.id);
      setOpen(false);
    },
  });

  // 点击外部关闭
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
  const current = list.find((w) => w.id === focusedWorkspaceId);
  const label = current ? current.name : 'Vault';

  // 拖卡到 switcher 上 → 加到当前 workspace（或弹下拉让用户选）
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
    if (!current) {
      setOpen(true); // 没有当前 workspace，弹下拉让用户选/建一个
      return;
    }
    // 加到当前 workspace
    const ws = await api.getWorkspace(current.id);
    if (!ws) return;
    if (ws.nodes.some((n) => n.kind === 'card' && n.cardId === payload.luhmannId)) {
      return; // 已在
    }
    const newNode: WorkspaceNode = {
      kind: 'card',
      id: randomUUID(),
      cardId: payload.luhmannId,
      x: 200 + Math.random() * 300,
      y: 200 + Math.random() * 200,
    };
    await api.updateWorkspace(current.id, {
      nodes: [...ws.nodes, newNode],
      edges: ws.edges,
    });
    qc.invalidateQueries({ queryKey: ['workspace', current.id] });
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
            : current
              ? 'bg-accentSoft text-accent border-accent/40'
              : 'bg-white text-ink border-gray-200 hover:border-accent/30'
        }`}
        title={current ? '点击切换 / 拖卡到这里加入' : '切换 workspace'}
      >
        <Sparkles size={12} className={current ? 'text-accent' : 'text-gray-400'} />
        <span className="max-w-[160px] truncate">{label}</span>
        <ChevronDown size={11} className="opacity-60" />
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 w-64 bg-white rounded-lg shadow-xl border border-gray-200 overflow-hidden z-50">
          <button
            onClick={() => {
              setFocusWorkspace(null);
              setOpen(false);
            }}
            className={`w-full text-left px-3 py-2 text-[12px] font-semibold transition-colors ${
              !current ? 'bg-gray-100 text-ink' : 'hover:bg-gray-50 text-gray-700'
            }`}
          >
            ← 返回 Vault
          </button>
          <div className="border-t border-gray-100" />
          <div className="max-h-64 overflow-y-auto">
            {list.length === 0 && (
              <div className="text-[11px] text-gray-400 px-3 py-3 italic">还没有工作区</div>
            )}
            {list.map((ws) => (
              <button
                key={ws.id}
                onClick={() => {
                  setFocusWorkspace(ws.id);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors ${
                  ws.id === focusedWorkspaceId ? 'bg-accentSoft' : 'hover:bg-gray-50'
                }`}
              >
                <span className="text-[12px] truncate">{ws.name}</span>
                <span className="text-[10px] text-gray-400 ml-2 shrink-0">
                  {ws.nodes.length} 节点
                </span>
              </button>
            ))}
          </div>
          <div className="border-t border-gray-100" />
          <button
            onClick={() => {
              const name = window.prompt('工作区名称：', '新工作区');
              if (name?.trim()) createMut.mutate(name.trim());
            }}
            disabled={createMut.isPending}
            className="w-full flex items-center gap-1.5 px-3 py-2 text-[12px] font-bold text-accent hover:bg-accentSoft transition-colors disabled:opacity-50"
          >
            <Plus size={12} />
            新工作区
          </button>
        </div>
      )}
    </div>
  );
}
