import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronRight, FileQuestion, FolderTree, Star, Tag, Trash2, X } from 'lucide-react';
import { api, type CardSummary, type IndexNode } from '../lib/api';
import { dialog } from '../lib/dialog';
import { useUIStore } from '../store/uiStore';
import { usePaneStore } from '../store/paneStore';
import { useNavigateToCard } from '../lib/useNavigateToCard';
import { setCardDragData } from '../lib/dragCard';

export function Sidebar() {
  const navigate = useNavigateToCard();
  const openTabFromStore = usePaneStore((s) => s.openTab);
  const openTagInPane = (name: string, opts?: { newTab?: boolean; splitDirection?: 'horizontal' }) =>
    openTabFromStore({ kind: 'tag', title: `#${name}`, tagName: name }, opts);
  const focusedId = useUIStore((s) => s.focusedCardId);
  const focusedBoxId = useUIStore((s) => s.focusedBoxId);
  const focusedTag = useUIStore((s) => s.focusedTag);

  const tagsQ = useQuery({ queryKey: ['tags'], queryFn: api.listTags });
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const indexesQ = useQuery({ queryKey: ['indexes'], queryFn: api.listIndexes });
  const starredQ = useQuery({ queryKey: ['starred'], queryFn: api.listStarred });
  const qc = useQueryClient();
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteCard(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['indexes'] });
      qc.invalidateQueries({ queryKey: ['positions'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
  // tag 改名 / 删除会改写大量卡片的 frontmatter+正文，凡是缓存了卡片内容的查询都得失效
  // 用 refetchQueries 而不是 invalidateQueries——前者立刻强制重发请求，
  // 后者只标 stale 等下次观察时再发，碰到边界情况可能延迟刷新
  const invalidateAfterTagOp = async () => {
    await Promise.all([
      qc.refetchQueries({ queryKey: ['tags'] }),
      qc.refetchQueries({ queryKey: ['cards'] }),
      qc.refetchQueries({ queryKey: ['card'] }), // 匹配 ['card', id] 全部单卡
      qc.refetchQueries({ queryKey: ['linked'] }),
      qc.refetchQueries({ queryKey: ['related-batch'] }),
      qc.refetchQueries({ queryKey: ['referenced-from'] }),
      qc.refetchQueries({ queryKey: ['tag-cards'] }),
    ]);
  };
  const renameTagMut = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      api.renameTag(oldName, newName),
    onSuccess: invalidateAfterTagOp,
  });
  const deleteTagMut = useMutation({
    mutationFn: (name: string) => api.deleteTag(name),
    onSuccess: invalidateAfterTagOp,
  });

  // 把 daily 卡和 orphan 卡（不在任何 INDEX 树里的顶层卡）从主流分离
  const { dailies, orphans } = useMemo(() => {
    const allCards = cardsQ.data?.cards ?? [];
    const tree = indexesQ.data?.tree ?? [];
    // 收集 INDEX 树里出现过的所有 id
    const indexed = new Set<string>();
    const walk = (nodes: IndexNode[]) => {
      for (const n of nodes) {
        indexed.add(n.luhmannId);
        walk(n.children);
      }
    };
    walk(tree);
    const dailyRe = /^daily(\d{8})$/;
    const dailies: CardSummary[] = [];
    const orphans: CardSummary[] = [];
    for (const c of allCards) {
      if (dailyRe.test(c.luhmannId)) {
        dailies.push(c);
      } else if (!indexed.has(c.luhmannId) && c.depth === 1) {
        // 顶层卡 + 不在任何 INDEX 引用链里 → 孤儿
        orphans.push(c);
      }
    }
    // dailies 按日期降序（最新在前）
    dailies.sort((a, b) => b.luhmannId.localeCompare(a.luhmannId));
    orphans.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    return { dailies, orphans };
  }, [cardsQ.data, indexesQ.data]);

  const formatDailyDate = (id: string) => {
    const m = id.match(/^daily(\d{4})(\d{2})(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : id;
  };

  return (
    <aside className="w-72 h-full border-r border-gray-200 bg-white dark:bg-[#1e2030] dark:border-[#363a4f] flex flex-col">
      <header className="h-12 px-5 flex items-center border-b border-gray-100">
        <span className="font-bold text-sm tracking-tight">Vault</span>
      </header>

      {/* Starred: 顶部置顶 */}
      {(starredQ.data?.ids ?? []).length > 0 && (
        <Section icon={<Star size={12} />} title="STARRED">
          {(() => {
            const cardById = new Map((cardsQ.data?.cards ?? []).map((c) => [c.luhmannId, c]));
            return (starredQ.data?.ids ?? []).map((id) => {
              const c = cardById.get(id);
              return (
                <button
                  key={id}
                  onClick={(e) => navigate(id, modifiersToOpts(e))}
                  className={`group w-full flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-gray-50 text-left ${
                    focusedId === id ? 'bg-accentSoft' : ''
                  }`}
                  title={c?.title ?? id}
                >
                  <Star size={10} className="text-amber-400 fill-amber-400 shrink-0" />
                  <span className="font-mono text-[10px] text-gray-500 w-12 shrink-0">{id}</span>
                  <span className="text-[12px] truncate flex-1 min-w-0">
                    {c?.title ?? <span className="italic text-gray-400">missing</span>}
                  </span>
                </button>
              );
            });
          })()}
        </Section>
      )}

      {/* Indexes tree: 主区，可滚动 */}
      <Section icon={<FolderTree size={12} />} title="INDEXES" scroll>
        {indexesQ.data?.tree.length ? (
          indexesQ.data.tree.map((node) => (
            <IndexNodeView
              key={node.luhmannId}
              node={node}
              level={0}
              focusedId={focusedId}
              focusedBoxId={focusedBoxId}
              onSelect={navigate}
            />
          ))
        ) : (
          <div className="text-[11px] text-gray-400 px-3 py-1.5 leading-relaxed">
            No index cards yet. When creating a card, set its status to Index and use [[link]] in the body to reference others.
          </div>
        )}
      </Section>

      {/* Tags: 内联 chips，自动换行；右键改名 */}
      <Section icon={<Tag size={12} />} title="TAGS">
        {(tagsQ.data?.tags ?? []).length === 0 ? (
          <div className="text-[11px] text-gray-400 px-3 py-1.5">No tags yet</div>
        ) : (
          <ChunkedList
            items={(tagsQ.data?.tags ?? [])
              .slice()
              .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))}
            initial={40}
            step={40}
            label="tags"
            wrapper={(children) => <div className="flex flex-wrap gap-1.5 px-1">{children}</div>}
            render={(t) => (
                <span
                  key={t.name}
                  className={`group/chip inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11px] font-semibold transition-colors ${
                    focusedTag === t.name
                      ? 'bg-accent text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-accentSoft hover:text-accent'
                  }`}
                  title={`#${t.name} · ${t.count} cards · right-click to rename`}
                >
                  <button
                    onClick={(e) => openTagInPane(t.name, modifiersToOpts(e))}
                    onContextMenu={async (e) => {
                      e.preventDefault();
                      const newName = await dialog.prompt(`Rename #${t.name} to:`, {
                        title: 'Rename tag',
                        defaultValue: t.name,
                        confirmLabel: 'Rename',
                      });
                      if (!newName?.trim() || newName.trim() === t.name) return;
                      try {
                        await renameTagMut.mutateAsync({
                          oldName: t.name,
                          newName: newName.trim(),
                        });
                      } catch (err) {
                        dialog.alert((err as Error).message, { title: 'Rename failed' });
                      }
                    }}
                    className="inline-flex items-center gap-1"
                  >
                    <span>#{t.name}</span>
                    <span
                      className={`text-[9px] tabular-nums ${
                        focusedTag === t.name ? 'text-white/70' : 'text-gray-400'
                      }`}
                    >
                      {t.count}
                    </span>
                  </button>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      const ok = await dialog.confirm(
                        `Delete tag #${t.name} from ${t.count} card${t.count === 1 ? '' : 's'}?`,
                        {
                          title: 'Delete tag',
                          description:
                            'The tag is removed from frontmatter and inline #tag of every card. Cards themselves are kept.',
                          confirmLabel: 'Delete',
                          variant: 'danger',
                        },
                      );
                      if (!ok) return;
                      try {
                        await deleteTagMut.mutateAsync(t.name);
                      } catch (err) {
                        dialog.alert((err as Error).message, { title: 'Delete failed' });
                      }
                    }}
                    className={`rounded-full p-0.5 transition-colors ${
                      focusedTag === t.name
                        ? 'text-white/70 hover:bg-white/20 hover:text-white'
                        : 'text-gray-400 hover:bg-red-100 hover:text-red-500'
                    }`}
                    title={`Delete tag #${t.name}`}
                  >
                    <X size={10} />
                  </button>
                </span>
            )}
          />
        )}
      </Section>

      {/* DAILY: 最近的每日笔记，时间倒序 */}
      {dailies.length > 0 && (
        <Section icon={<CalendarDays size={12} />} title="DAILY">
          {dailies.slice(0, 7).map((c) => (
            <button
              key={c.luhmannId}
              onClick={(e) => navigate(c.luhmannId, modifiersToOpts(e))}
              className={`w-full flex items-center gap-2 px-3 py-1 rounded-md hover:bg-gray-50 text-left ${
                focusedId === c.luhmannId ? 'bg-accentSoft' : ''
              }`}
            >
              <span className="font-mono text-[10px] text-gray-500 shrink-0">
                {formatDailyDate(c.luhmannId)}
              </span>
            </button>
          ))}
          {dailies.length > 7 && (
            <div className="text-[10px] text-gray-400 px-3 pt-1">
              + {dailies.length - 7} earlier
            </div>
          )}
        </Section>
      )}

      {/* ORPHANS: 不在任何 INDEX 树里的顶层卡 */}
      {orphans.length > 0 && (
        <Section icon={<FileQuestion size={12} />} title="ORPHANS">
          <div className="text-[10px] text-gray-400 px-1 mb-1.5 italic leading-relaxed">
            Top-level cards not yet referenced by any INDEX
          </div>
          <ChunkedList
            items={orphans}
            initial={50}
            step={50}
            label="orphans"
            render={(c) => (
              <div
                key={c.luhmannId}
                className={`group flex items-center gap-2 px-2 py-1 rounded-md hover:bg-gray-50 cursor-grab active:cursor-grabbing ${
                  focusedId === c.luhmannId ? 'bg-accentSoft' : ''
                }`}
                draggable
                onDragStart={(e) => setCardDragData(e, { luhmannId: c.luhmannId, title: c.title })}
                onClick={(e) => navigate(c.luhmannId, modifiersToOpts(e))}
                title="Drag to workspace"
              >
                <span className="font-mono text-[10px] text-gray-500 w-10 shrink-0">{c.luhmannId}</span>
                <span className="text-[12px] truncate flex-1 min-w-0">{c.title}</span>
                {c.status === 'INDEX' && (
                  <span className="text-[8px] font-bold text-accent shrink-0">IDX</span>
                )}
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    const ok = await dialog.confirm(`Delete ${c.luhmannId}?`, {
                      title: 'Delete card',
                      confirmLabel: 'Delete',
                      variant: 'danger',
                    });
                    if (ok) deleteMut.mutate(c.luhmannId);
                  }}
                  className="p-0.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  title="Delete"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            )}
          />
        </Section>
      )}
    </aside>
  );
}

/**
 * 简易"分块加载"列表：先渲染 initial 个，再点 "show more" 加载下一批。
 * 比 react-window 类的虚拟化简单粗暴但够用——侧栏滚动场景不需要复杂的窗口管理。
 */
function ChunkedList<T>({
  items,
  initial,
  step,
  label,
  render,
  wrapper,
}: {
  items: T[];
  initial: number;
  step: number;
  label: string;
  render: (item: T, index: number) => React.ReactNode;
  wrapper?: (children: React.ReactNode) => React.ReactNode;
}) {
  const [shown, setShown] = useState(initial);
  const visible = items.slice(0, shown);
  const remaining = items.length - shown;
  const list = visible.map((it, i) => render(it, i));
  return (
    <>
      {wrapper ? wrapper(list) : list}
      {remaining > 0 && (
        <button
          onClick={() => setShown((s) => s + step)}
          className="w-full mt-1.5 text-[10px] text-accent hover:underline px-1 py-1 text-left"
        >
          + show {Math.min(step, remaining)} more {label} ({remaining} hidden)
        </button>
      )}
    </>
  );
}

function IndexNodeView({
  node,
  level,
  focusedId,
  focusedBoxId,
  onSelect,
}: {
  node: IndexNode;
  level: number;
  focusedId: string | null;
  focusedBoxId: string | null;
  onSelect: (id: string, opts?: { newTab?: boolean; splitDirection?: 'horizontal' | 'vertical' }) => void;
}) {
  const [expanded, setExpanded] = useState(level < 1);
  const hasChildren = node.children.length > 0;
  const isIndex = node.status === 'INDEX';
  // INDEX 节点：当它是当前 box 时高亮（即使 focusedCardId 不是它）
  // ATOMIC 节点：当它是 focused card 时高亮
  const highlighted = isIndex
    ? focusedBoxId === node.luhmannId
    : focusedId === node.luhmannId;

  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded-md text-left hover:bg-gray-50 ${
          highlighted ? 'bg-accentSoft' : ''
        }`}
        style={{ paddingLeft: 4 + level * 14 }}
      >
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 text-gray-400 hover:text-ink shrink-0"
          >
            <ChevronRight
              size={12}
              className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          </button>
        ) : (
          <span className="w-5" />
        )}
        <button
          onClick={(e) => onSelect(node.luhmannId, modifiersToOpts(e))}
          draggable
          onDragStart={(e) => setCardDragData(e, { luhmannId: node.luhmannId, title: node.title })}
          className="flex-1 min-w-0 flex items-center gap-1.5 py-1.5 text-left cursor-grab active:cursor-grabbing"
          title="Drag to workspace · ⌘ click new tab · ⌘⇧ click split"
        >
          <span
            className={`font-mono text-[9.5px] font-bold px-1 py-0.5 rounded shrink-0 ${
              isIndex ? 'bg-accent text-white' : 'bg-gray-100 text-gray-600'
            }`}
          >
            {node.luhmannId}
          </span>
          <span
            className={`text-[12px] truncate ${isIndex ? 'font-semibold text-ink' : 'text-gray-700'}`}
          >
            {node.title}
          </span>
        </button>
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children.map((c) => (
            <IndexNodeView
              key={c.luhmannId}
              node={c}
              level={level + 1}
              focusedId={focusedId}
              focusedBoxId={focusedBoxId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  children,
  scroll,
}: {
  icon?: React.ReactNode;
  title?: string;
  children: React.ReactNode;
  scroll?: boolean;
}) {
  return (
    <div className={`px-4 py-4 border-b border-gray-100 ${scroll ? 'flex-1 overflow-y-auto' : ''}`}>
      {title && (
        <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3 px-1">
          {icon}
          <span>{title}</span>
        </div>
      )}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

/** ⌘ click → 新 tab；⌘+⇧ click → split right */
function modifiersToOpts(
  e: React.MouseEvent,
): { newTab?: boolean; splitDirection?: 'horizontal' } {
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && e.shiftKey) return { splitDirection: 'horizontal' };
  if (cmd) return { newTab: true };
  return {};
}
