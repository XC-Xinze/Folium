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

  /**
   * Restore 流程：
   *  1. 先用 strategy='fail' 试一发；若 backend 报 "already exists" → 探测到 id 冲突
   *  2. 弹 dialog 让用户三选一：用 next-available / 替换现有 / 取消
   *  3. 用选择的 strategy 重发
   */
  const tryRestore = async (fileName: string, originalId: string) => {
    try {
      const result = await api.restoreTrash(fileName, 'fail');
      invalidateAll();
      if (result.conflict) {
        dialog.alert(`Restored as ${result.luhmannId}`, { title: 'Restored' });
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes('already exists')) {
        dialog.alert(msg, { title: 'Restore failed' });
        return;
      }
      // 冲突 → 用户选策略
      const choice = await dialog.prompt(
        `Card "${originalId}" already exists in vault.\n\nType:\n  "n" → restore as next available id\n  "r" → REPLACE existing (current goes to trash)\n  empty → cancel`,
        {
          title: 'Id conflict on restore',
          defaultValue: 'n',
          confirmLabel: 'OK',
        },
      );
      const c = choice?.trim().toLowerCase();
      if (!c) return;
      const strategy = c === 'r' ? 'replace' : 'next-available';
      try {
        const result = await api.restoreTrash(fileName, strategy);
        invalidateAll();
        if (strategy === 'replace') {
          dialog.alert(
            `Restored as ${result.luhmannId}. Previous ${originalId} moved to trash.`,
            { title: 'Restored (replaced)' },
          );
        } else {
          dialog.alert(
            `Restored as ${result.luhmannId} (original id ${originalId} kept the existing card).`,
            { title: 'Restored under new id' },
          );
        }
      } catch (err2) {
        dialog.alert((err2 as Error).message, { title: 'Restore failed' });
      }
    }
  };
  const restoreMut = useMutation({
    mutationFn: ({ fileName, originalId }: { fileName: string; originalId: string }) =>
      tryRestore(fileName, originalId),
  });
  const purgeMut = useMutation({
    mutationFn: (fileName: string) => api.purgeTrashEntry(fileName),
    onSuccess: invalidateAll,
  });
  const emptyMut = useMutation({
    mutationFn: () => api.emptyTrash(),
    onSuccess: invalidateAll,
  });

  const wsTrashQ = useQuery({ queryKey: ['ws-trash'], queryFn: api.listWsTrash });
  const tempTrashQ = useQuery({ queryKey: ['temp-trash'], queryFn: api.listTempTrash });

  const restoreWsMut = useMutation({
    mutationFn: (fileName: string) => api.restoreWsTrash(fileName),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ws-trash'] });
      qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
    onError: (err: Error) => dialog.alert(err.message, { title: 'Restore failed' }),
  });
  const purgeWsMut = useMutation({
    mutationFn: (fileName: string) => api.purgeWsTrash(fileName),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws-trash'] }),
  });
  const restoreTempMut = useMutation({
    mutationFn: (fileName: string) => api.restoreTempTrash(fileName),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['temp-trash'] });
      qc.invalidateQueries({ queryKey: ['workspace', result.workspaceId] });
      qc.invalidateQueries({ queryKey: ['ws-links-batch'] });
    },
    onError: (err: Error) => dialog.alert(err.message, { title: 'Restore failed' }),
  });
  const purgeTempMut = useMutation({
    mutationFn: (fileName: string) => api.purgeTempTrash(fileName),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['temp-trash'] }),
  });

  const cardEntries = trashQ.data?.entries ?? [];
  const wsEntries = wsTrashQ.data?.entries ?? [];
  const tempEntries = tempTrashQ.data?.entries ?? [];
  const total = cardEntries.length + wsEntries.length + tempEntries.length;

  if (total === 0) {
    return (
      <p className="text-[12px] text-gray-500 italic">
        Trash is empty. Deleted cards / workspaces / temp cards land here for safekeeping.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {cardEntries.length > 0 && (
        <TrashGroup
          label={`Cards (${cardEntries.length})`}
          path=".zettel/trash/"
          onEmptyAll={async () => {
            const ok = await dialog.confirm(
              `Permanently delete all ${cardEntries.length} card${cardEntries.length === 1 ? '' : 's'}?`,
              { title: 'Empty cards', confirmLabel: 'Empty', variant: 'danger' },
            );
            if (ok) emptyMut.mutate();
          }}
        >
          {cardEntries.map((e) => (
            <TrashRow
              key={e.fileName}
              badge={e.luhmannId}
              title={e.title}
              deletedAt={e.deletedAt}
              onRestore={() => restoreMut.mutate({ fileName: e.fileName, originalId: e.luhmannId })}
              onPurge={async () => {
                const ok = await dialog.confirm(
                  `Permanently delete "${e.title}"?`,
                  { title: 'Permanent delete', confirmLabel: 'Delete', variant: 'danger' },
                );
                if (ok) purgeMut.mutate(e.fileName);
              }}
            />
          ))}
        </TrashGroup>
      )}

      {wsEntries.length > 0 && (
        <TrashGroup label={`Workspaces (${wsEntries.length})`} path=".zettel/ws-trash/">
          {wsEntries.map((e) => (
            <TrashRow
              key={e.fileName}
              badge="WS"
              badgeColor="bg-purple-100 text-purple-700"
              title={e.workspace.name}
              deletedAt={e.deletedAt}
              onRestore={() => restoreWsMut.mutate(e.fileName)}
              onPurge={async () => {
                const ok = await dialog.confirm(
                  `Permanently delete workspace "${e.workspace.name}"?`,
                  { title: 'Permanent delete', confirmLabel: 'Delete', variant: 'danger' },
                );
                if (ok) purgeWsMut.mutate(e.fileName);
              }}
            />
          ))}
        </TrashGroup>
      )}

      {tempEntries.length > 0 && (
        <TrashGroup label={`Temp cards (${tempEntries.length})`} path=".zettel/temp-trash/">
          {tempEntries.map((e) => (
            <TrashRow
              key={e.fileName}
              badge="Temp"
              badgeColor="bg-amber-100 text-amber-700"
              title={e.node.title || '(untitled)'}
              hint={`from workspace: ${e.workspaceName}`}
              deletedAt={e.deletedAt}
              onRestore={() => restoreTempMut.mutate(e.fileName)}
              onPurge={async () => {
                const ok = await dialog.confirm(
                  `Permanently delete temp card?`,
                  { title: 'Permanent delete', confirmLabel: 'Delete', variant: 'danger' },
                );
                if (ok) purgeTempMut.mutate(e.fileName);
              }}
            />
          ))}
        </TrashGroup>
      )}
    </div>
  );
}

function TrashGroup({
  label,
  path,
  onEmptyAll,
  children,
}: {
  label: string;
  path: string;
  onEmptyAll?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-gray-500">
          {label} · <code className="text-[11px]">{path}</code>
        </p>
        {onEmptyAll && (
          <button onClick={onEmptyAll} className="text-[11px] font-bold text-red-500 hover:text-red-600">
            Empty
          </button>
        )}
      </div>
      <div className="border border-gray-200 dark:border-[#363a4f] rounded divide-y divide-gray-100 dark:divide-[#363a4f]">
        {children}
      </div>
    </div>
  );
}

function TrashRow({
  badge,
  badgeColor = 'bg-gray-100 text-gray-700',
  title,
  hint,
  deletedAt,
  onRestore,
  onPurge,
}: {
  badge: string;
  badgeColor?: string;
  title: string;
  hint?: string;
  deletedAt: string;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 group hover:bg-gray-50">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`font-mono text-[10px] font-bold px-1.5 py-0.5 rounded ${badgeColor}`}>{badge}</span>
          <span className="text-[12px] truncate font-semibold">{title}</span>
        </div>
        <div className="text-[10px] text-gray-400 mt-0.5">
          {hint ? `${hint} · ` : ''}deleted at {new Date(deletedAt).toLocaleString()}
        </div>
      </div>
      <button
        onClick={onRestore}
        className="opacity-0 group-hover:opacity-100 flex items-center gap-1 text-[11px] font-bold text-emerald-600 hover:text-emerald-700 px-2 py-1 rounded hover:bg-emerald-50"
        title="Restore"
      >
        <RotateCcw size={11} /> Restore
      </button>
      <button
        onClick={onPurge}
        className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500"
        title="Permanently delete"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}
