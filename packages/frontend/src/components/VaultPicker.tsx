/**
 * Vault picker：Sidebar 底部的下拉，显示当前 vault 名 + 列表切换 + Open another / Remove。
 *
 * 切换流程：
 *   1. 调 /api/vaults/switch（后端会 truncate db + rescan + restart watcher）
 *   2. queryClient.clear() —— 整个 cache 都跟旧 vault 绑定，全清重来
 *   3. paneStore.reset() —— tabs 里的 cardId 都属于旧 vault，清空
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronUp, FolderOpen, Plus, X } from 'lucide-react';
import { api, type VaultEntry } from '../lib/api';
import { dialog } from '../lib/dialog';
import { usePaneStore } from '../store/paneStore';

export function VaultPicker() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const vaultsQ = useQuery({ queryKey: ['vaults'], queryFn: api.listVaults });

  const refreshAfterChange = async () => {
    qc.clear();
    // 切 vault 后旧 tabs 里的 cardId 都失效，整体重置 paneStore
    usePaneStore.getState().reset();
    await qc.refetchQueries({ queryKey: ['vaults'] });
  };

  const switchMut = useMutation({
    mutationFn: (id: string) => api.switchVault(id),
    onSuccess: async () => {
      await refreshAfterChange();
      setOpen(false);
    },
  });

  const registerAndSwitchMut = useMutation({
    mutationFn: async ({ path, name }: { path: string; name?: string }) => {
      const { vault } = await api.registerVault(path, name);
      // 自动切到新注册的 vault
      await api.switchVault(vault.id);
      return vault;
    },
    onSuccess: async () => {
      await refreshAfterChange();
      setOpen(false);
    },
  });

  const unregisterMut = useMutation({
    mutationFn: (id: string) => api.unregisterVault(id),
    onSuccess: async () => {
      await refreshAfterChange();
    },
  });

  const active = vaultsQ.data?.active;
  const vaults = vaultsQ.data?.vaults ?? [];

  const handleAddVault = async () => {
    const path = await dialog.prompt(
      'Vault path（绝对路径或 ~/...，目录必须存在）',
      {
        title: 'Open another vault',
        defaultValue: '',
        confirmLabel: 'Open',
      },
    );
    if (!path?.trim()) return;
    try {
      await registerAndSwitchMut.mutateAsync({ path: path.trim() });
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Failed to open vault' });
    }
  };

  const handleRemove = async (v: VaultEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    if (vaults.length === 1) {
      dialog.alert('Cannot remove the only registered vault.', { title: 'Remove vault' });
      return;
    }
    const ok = await dialog.confirm(`Forget vault "${v.name}"?`, {
      title: 'Remove from registry',
      description: `The folder at ${v.path} will NOT be deleted, only forgotten by the app.`,
      confirmLabel: 'Forget',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await unregisterMut.mutateAsync(v.id);
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Remove failed' });
    }
  };

  const isPending = switchMut.isPending || registerAndSwitchMut.isPending;

  return (
    <div className="border-t border-gray-100 dark:border-[#363a4f] relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={isPending}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-gray-50 dark:hover:bg-[#24273a] text-left"
        title={active?.path ?? 'No active vault'}
      >
        <FolderOpen size={14} className="text-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400 leading-tight">
            Vault
          </div>
          <div className="text-[12px] truncate">
            {isPending ? 'Switching…' : (active?.name ?? 'None')}
          </div>
        </div>
        <ChevronUp
          size={14}
          className={`text-gray-400 transition-transform ${open ? '' : 'rotate-180'}`}
        />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 right-0 bg-white dark:bg-[#1e2030] border border-gray-200 dark:border-[#363a4f] rounded-md shadow-lg overflow-hidden mb-1 mx-2">
          <div className="max-h-60 overflow-y-auto">
            {vaults.map((v) => (
              <button
                key={v.id}
                onClick={() => v.id !== active?.id && switchMut.mutate(v.id)}
                className={`group/v w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-[#24273a] ${
                  v.id === active?.id ? 'bg-accentSoft' : ''
                }`}
                title={v.path}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium truncate">{v.name}</div>
                  <div className="text-[10px] text-gray-400 truncate font-mono">{v.path}</div>
                </div>
                {v.id === active?.id && (
                  <span className="text-[10px] text-accent font-bold shrink-0">ACTIVE</span>
                )}
                <button
                  onClick={(e) => handleRemove(v, e)}
                  className="opacity-0 group-hover/v:opacity-100 text-gray-300 hover:text-red-500 p-1 shrink-0 transition-opacity"
                  title="Forget this vault"
                >
                  <X size={12} />
                </button>
              </button>
            ))}
          </div>
          <button
            onClick={handleAddVault}
            disabled={isPending}
            className="w-full flex items-center gap-2 px-3 py-2 text-[12px] border-t border-gray-100 dark:border-[#363a4f] hover:bg-gray-50 dark:hover:bg-[#24273a] text-accent"
          >
            <Plus size={12} />
            Open another vault…
          </button>
        </div>
      )}
    </div>
  );
}
