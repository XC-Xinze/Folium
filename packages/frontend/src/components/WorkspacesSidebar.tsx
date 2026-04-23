import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useUIStore } from '../store/uiStore';
import { RenamableName } from './RenamableName';

/**
 * Sidebar 在 'workspaces' tab 下展示的内容。
 *   - 列出所有工作区
 *   - 点击 → 在右侧面板打开
 *   - 加号 → 新建
 *   - hover 出删除按钮
 */
export function WorkspacesSidebar() {
  const focusedWorkspaceId = useUIStore((s) => s.focusedWorkspaceId);
  const setFocusWorkspace = useUIStore((s) => s.setFocusWorkspace);
  const qc = useQueryClient();

  const wsQ = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces });

  const createMut = useMutation({
    mutationFn: (name: string) => api.createWorkspace(name),
    onSuccess: (ws) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      setFocusWorkspace(ws.id);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteWorkspace(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      if (focusedWorkspaceId === id) setFocusWorkspace(null);
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.updateWorkspace(id, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });

  return (
    <aside className="w-72 h-full border-r border-gray-200 bg-white flex flex-col">
      <header className="h-12 px-5 flex items-center justify-between border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-accent" />
          <span className="font-bold text-sm tracking-tight">工作区</span>
        </div>
        <button
          onClick={() => {
            const name = window.prompt('工作区名称：', '新工作区');
            if (name?.trim()) createMut.mutate(name.trim());
          }}
          className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-accent"
          title="新建工作区"
        >
          <Plus size={14} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        {(wsQ.data?.workspaces ?? []).length === 0 && (
          <div className="text-[11px] text-gray-400 px-2 py-3 italic leading-relaxed">
            还没有工作区。点上面 + 创建一个，把 vault 的卡片拖进去自由布局做脑暴。
          </div>
        )}
        <div className="space-y-1">
          {(wsQ.data?.workspaces ?? []).map((ws) => (
            <div
              key={ws.id}
              className={`group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                focusedWorkspaceId === ws.id
                  ? 'bg-accentSoft text-accent'
                  : 'hover:bg-gray-50 text-gray-700'
              }`}
              onClick={() => setFocusWorkspace(ws.id)}
            >
              <RenamableName
                value={ws.name}
                onSave={(name) => renameMut.mutate({ id: ws.id, name })}
                className="flex-1 text-[12px] font-semibold truncate"
              />
              <span className="text-[9px] text-gray-400 shrink-0">{ws.nodes.length}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`删除工作区 "${ws.name}"？`)) deleteMut.mutate(ws.id);
                }}
                className="p-0.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                title="删除"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
