import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { dialog } from '../lib/dialog';

/**
 * Settings 里的回收站面板：列出 .zettel/trash/ 下所有删过的卡，可单条还原 / 永久删除，
 * 或一键清空。
 */
export function TrashPanel() {
  const qc = useQueryClient();
  const trashQ = useQuery({ queryKey: ['trash'], queryFn: api.listTrash });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['trash'] });
    qc.invalidateQueries({ queryKey: ['cards'] });
    qc.invalidateQueries({ queryKey: ['indexes'] });
    qc.invalidateQueries({ queryKey: ['tags'] });
  };

  const restoreMut = useMutation({
    mutationFn: (fileName: string) => api.restoreTrash(fileName),
    onSuccess: invalidateAll,
    onError: (err: Error) => dialog.alert(err.message, { title: 'Restore failed' }),
  });
  const purgeMut = useMutation({
    mutationFn: (fileName: string) => api.purgeTrashEntry(fileName),
    onSuccess: invalidateAll,
  });
  const emptyMut = useMutation({
    mutationFn: () => api.emptyTrash(),
    onSuccess: invalidateAll,
  });

  const entries = trashQ.data?.entries ?? [];

  if (entries.length === 0) {
    return (
      <p className="text-[12px] text-gray-500 italic">
        Trash is empty. Deleted cards land here for safekeeping.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-gray-500">
          {entries.length} item{entries.length === 1 ? '' : 's'} · stored in{' '}
          <code className="text-[11px]">.zettel/trash/</code>
        </p>
        <button
          onClick={async () => {
            const ok = await dialog.confirm(
              `Permanently delete all ${entries.length} item${entries.length === 1 ? '' : 's'} in trash?`,
              { title: 'Empty trash', confirmLabel: 'Empty', variant: 'danger' },
            );
            if (ok) emptyMut.mutate();
          }}
          className="text-[11px] font-bold text-red-500 hover:text-red-600"
        >
          Empty trash
        </button>
      </div>
      <div className="border border-gray-200 dark:border-[#363a4f] rounded divide-y divide-gray-100 dark:divide-[#363a4f]">
        {entries.map((e) => (
          <div
            key={e.fileName}
            className="flex items-center gap-3 px-3 py-2 group hover:bg-gray-50"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">
                  {e.luhmannId}
                </span>
                <span className="text-[12px] truncate font-semibold">{e.title}</span>
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5">
                deleted at {new Date(e.deletedAt).toLocaleString()}
              </div>
            </div>
            <button
              onClick={() => restoreMut.mutate(e.fileName)}
              disabled={restoreMut.isPending}
              className="opacity-0 group-hover:opacity-100 flex items-center gap-1 text-[11px] font-bold text-emerald-600 hover:text-emerald-700 px-2 py-1 rounded hover:bg-emerald-50"
              title="Restore to vault"
            >
              <RotateCcw size={11} /> Restore
            </button>
            <button
              onClick={async () => {
                const ok = await dialog.confirm(
                  `Permanently delete "${e.title}"? This cannot be undone.`,
                  { title: 'Permanent delete', confirmLabel: 'Delete', variant: 'danger' },
                );
                if (ok) purgeMut.mutate(e.fileName);
              }}
              className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500"
              title="Permanently delete"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
