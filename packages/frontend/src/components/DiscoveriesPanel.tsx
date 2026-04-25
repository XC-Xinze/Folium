import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Compass, Plus, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { dialog } from '../lib/dialog';

/**
 * 发现：vault 里"看起来是同一类、但还没被 INDEX 收"的卡簇。
 * 用户可一键给这个簇建一张新 INDEX，把它们 [[link]] 起来。
 */
export function DiscoveriesPanel() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['discoveries'],
    queryFn: api.getDiscoveries,
    // 计算稍重，不主动刷；用户点 reload 才重算
    staleTime: Infinity,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['discoveries'] });

  if (q.isLoading) return <p className="text-[12px] text-gray-500">Computing clusters…</p>;
  const clusters = q.data?.clusters ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-gray-500 dark:text-gray-400">
          {clusters.length === 0
            ? 'No undiscovered clusters. Either everything is well-indexed, or there aren\'t enough strong content links yet.'
            : `${clusters.length} cluster${clusters.length === 1 ? '' : 's'} found —— cards that look related but no INDEX groups them.`}
        </p>
        <button
          onClick={refresh}
          className="text-[11px] font-bold flex items-center gap-1.5 px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <RefreshCw size={11} />
          Recompute
        </button>
      </div>

      {clusters.map((cluster, i) => {
        const idStem = `cluster-${i}`;
        const busy = creating === idStem;
        return (
          <div
            key={i}
            className="border border-gray-200 dark:border-gray-700 rounded p-3 space-y-2"
          >
            <div className="flex items-center gap-2">
              <Compass size={12} className="text-accent" />
              <span className="text-[11px] font-bold text-gray-700 dark:text-gray-300">
                {cluster.cards.length} cards
              </span>
              {cluster.hintTags.length > 0 && (
                <>
                  <span className="text-gray-300">·</span>
                  <span className="text-[11px] text-gray-500">often tagged</span>
                  {cluster.hintTags.map((t) => (
                    <span key={t} className="text-[10px] font-bold text-accent">
                      #{t}
                    </span>
                  ))}
                </>
              )}
              <div className="flex-1" />
              <button
                disabled={busy}
                onClick={async () => {
                  const name = await dialog.prompt('New INDEX title', {
                    title: 'Group as INDEX',
                    defaultValue:
                      cluster.hintTags[0] ? `Index: ${cluster.hintTags[0]}` : 'New cluster index',
                    confirmLabel: 'Create',
                  });
                  if (!name?.trim()) return;
                  const luhmannId = await dialog.prompt('Pick an INDEX id', {
                    title: 'Group as INDEX',
                    defaultValue: 'i-cluster',
                    confirmLabel: 'Create',
                  });
                  if (!luhmannId?.trim()) return;
                  setCreating(idStem);
                  try {
                    const body =
                      `# ${name.trim()}\n\n自动从内容相似簇生成。\n\n` +
                      cluster.cards.map((c) => `- [[${c.luhmannId}]] ${c.title}`).join('\n');
                    // status 不再传：当用户给这张新 INDEX-意图卡新建子卡（如 1a/1b）时
                    // 它自动升级成 INDEX。这里只是先把卡本身建出来。
                    await api.createCard({
                      luhmannId: luhmannId.trim(),
                      title: name.trim(),
                      content: body,
                      tags: cluster.hintTags,
                    });
                    qc.invalidateQueries();
                  } catch (err) {
                    dialog.alert((err as Error).message, { title: 'Create failed' });
                  } finally {
                    setCreating(null);
                  }
                }}
                className="text-[11px] font-bold flex items-center gap-1 px-2.5 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40"
              >
                <Plus size={11} />
                {busy ? 'Creating…' : 'Group as INDEX'}
              </button>
            </div>
            <ul className="text-[11px] space-y-0.5 pl-4">
              {cluster.cards.map((c) => (
                <li key={c.luhmannId} className="flex items-baseline gap-2">
                  <code className="font-mono text-[10px] text-accent shrink-0">{c.luhmannId}</code>
                  <span className="truncate text-gray-700 dark:text-gray-300">{c.title}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
