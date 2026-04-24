import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { dialog } from '../lib/dialog';
import { usePaneStore } from '../store/paneStore';
import { RenamableName } from './RenamableName';

/**
 * Sidebar contents under the 'workspaces' tab.
 *   - lists all workspaces
 *   - click → opens in the right panel
 *   - plus → create new
 *   - hover → delete button
 */
export function WorkspacesSidebar() {
  const openTab = usePaneStore((s) => s.openTab);
  const qc = useQueryClient();

  const wsQ = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces });

  const createMut = useMutation({
    mutationFn: (name: string) => api.createWorkspace(name),
    onSuccess: (ws) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      openTab({ kind: 'workspace', title: ws.name, workspaceId: ws.id });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteWorkspace(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      usePaneStore
        .getState()
        .removeTabsWhere((t) => t.kind === 'workspace' && t.workspaceId === id);
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
          <span className="font-bold text-sm tracking-tight">Workspaces</span>
        </div>
        <button
          onClick={async () => {
            const name = await dialog.prompt('Workspace name', {
              title: 'New workspace',
              defaultValue: 'New workspace',
              confirmLabel: 'Create',
            });
            if (name?.trim()) createMut.mutate(name.trim());
          }}
          className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-accent"
          title="New workspace"
        >
          <Plus size={14} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        {(wsQ.data?.workspaces ?? []).length === 0 && (
          <div className="text-[11px] text-gray-400 px-2 py-3 italic leading-relaxed">
            No workspaces yet. Click + above to create one, then drag vault cards in to brainstorm.
          </div>
        )}
        <div className="space-y-1">
          {(wsQ.data?.workspaces ?? []).map((ws) => (
            <div
              key={ws.id}
              className="group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors hover:bg-gray-50 text-gray-700"
              onClick={(e) => {
                openTab(
                  { kind: 'workspace', title: ws.name, workspaceId: ws.id },
                  modifiersToOpts(e),
                );
              }}
            >
              <RenamableName
                value={ws.name}
                onSave={(name) => renameMut.mutate({ id: ws.id, name })}
                className="flex-1 text-[12px] font-semibold truncate"
              />
              <span className="text-[9px] text-gray-400 shrink-0">{ws.nodes.length}</span>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  const ok = await dialog.confirm(`Delete workspace "${ws.name}"?`, {
                    title: 'Delete workspace',
                    confirmLabel: 'Delete',
                    variant: 'danger',
                  });
                  if (ok) deleteMut.mutate(ws.id);
                }}
                className="p-0.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Delete"
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

/** ⌘ click → 新 tab；⌘+⇧ click → split right */
function modifiersToOpts(e: React.MouseEvent): { newTab?: boolean; splitDirection?: 'horizontal' } {
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && e.shiftKey) return { splitDirection: 'horizontal' };
  if (cmd) return { newTab: true };
  return {};
}
