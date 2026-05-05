import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronRight, Crown, FileQuestion, FolderTree, PackageOpen, Plus, Star, Tag, Trash2, X } from 'lucide-react';
import { api, type CardSummary, type IndexNode, type ResourceCard } from '../lib/api';
import { dialog } from '../lib/dialog';
import { useUIStore } from '../store/uiStore';
import { usePaneStore } from '../store/paneStore';
import { useNavigateToCard } from '../lib/useNavigateToCard';
import { isCardDrag, readCardDragData, setCardDragData, setResourceDragData } from '../lib/dragCard';
import { pushUndo } from '../lib/undoStack';
import { VaultPicker } from './VaultPicker';
import { MASTER_BOX_ID } from '../lib/cardGraph';
import { t } from '../lib/i18n';

/** Folgezettel 父：剥末尾连续同类（数字 / 字母）。daily 这种非 luhmann 返 null */
function parentOfId(id: string): string | null {
  if (!id || !/^[\da-z]+$/i.test(id)) return null;
  if (/\d$/.test(id)) return id.replace(/\d+$/, '') || null;
  if (/[a-z]$/i.test(id)) return id.replace(/[a-z]+$/i, '') || null;
  return null;
}

/**
 * 算 Folgezettel 树：每张卡按 id 推导父子。父若不存在就追溯到最近存在的祖先；
 * 还是没有就放在 root。结果：parentId → children id list（按 sortKey 排）
 *
 * Master 是虚拟概念（无 luhmannId），不是某张卡 —— Sidebar 顶部的"Vault"
 * 就是 master 入口。所以这棵树包含所有非 daily 卡，顶级 luhmannId（1/2/3...）
 * 自然作为 root 节点出现。
 */
function buildFolgezettelTree(
  cards: CardSummary[],
  excludeIds: Set<string>,
): Map<string | null, string[]> {
  const visible = cards.filter((c) => !excludeIds.has(c.luhmannId));
  const idSet = new Set(visible.map((c) => c.luhmannId));
  const childrenOf = new Map<string | null, string[]>();
  for (const c of visible) {
    let p: string | null = parentOfId(c.luhmannId);
    while (p && !idSet.has(p)) p = parentOfId(p);
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(c.luhmannId);
  }
  // 排序
  const cardById = new Map(visible.map((c) => [c.luhmannId, c]));
  for (const ids of childrenOf.values()) {
    ids.sort((a, b) =>
      (cardById.get(a)?.sortKey ?? a).localeCompare(cardById.get(b)?.sortKey ?? b),
    );
  }
  return childrenOf;
}

function nextTopLevelBoxId(cards: CardSummary[]): string {
  const existing = new Set(cards.map((c) => c.luhmannId));
  for (let n = 1; n < 100000; n++) {
    const id = String(n);
    if (!existing.has(id)) return id;
  }
  return String(existing.size + 1);
}

export function Sidebar() {
  const navigate = useNavigateToCard();
  const openTabFromStore = usePaneStore((s) => s.openTab);
  const openTagInPane = (name: string, opts?: { newTab?: boolean; splitDirection?: 'horizontal' }) =>
    openTabFromStore({ kind: 'tag', title: `#${name}`, tagName: name }, opts);
  const focusedId = useUIStore((s) => s.focusedCardId);
  const focusedBoxId = useUIStore((s) => s.focusedBoxId);
  const focusedTag = useUIStore((s) => s.focusedTag);
  const language = useUIStore((s) => s.language);
  const openNewCard = useUIStore((s) => s.openNewCard);

  const tagsQ = useQuery({ queryKey: ['tags'], queryFn: api.listTags });
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const indexesQ = useQuery({ queryKey: ['indexes'], queryFn: api.listIndexes });
  const starredQ = useQuery({ queryKey: ['starred'], queryFn: api.listStarred });
  const resourcesQ = useQuery({ queryKey: ['resources'], queryFn: () => api.listResources() });
  const qc = useQueryClient();
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteCard(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['indexes'] });
      qc.invalidateQueries({ queryKey: ['positions'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      usePaneStore.getState().retargetDeletedCardRefs(id);
      pushUndo({
        description: `Deleted card ${id}`,
        undo: async () => {
          const trash = await api.listTrash();
          const entry = trash.entries.find((e) => e.luhmannId === id);
          if (!entry) throw new Error('Trash entry not found');
          await api.restoreTrash(entry.fileName);
          qc.invalidateQueries();
        },
      });
    },
  });

  /**
   * Reparent 流程：
   *   1. dryRun 拿 rename map
   *   2. 弹 confirm 显示 map 让用户看清楚
   *   3. 真做 + 全量 invalidate（id 改了所有 query 都得刷）
   *   4. paneStore tabs 里指向旧 id 的也要修：用 removeTabsWhere 清掉（最稳，避免半残状态）
   */
  const reparentCard = async (sourceId: string, newParentId: string | null) => {
    if (sourceId === newParentId) return;
    try {
      const plan = await api.reparentCard(sourceId, newParentId, { dryRun: true });
      const renames = plan.renames;
      const entries = Object.entries(renames);
      if (entries.length === 0) {
        // 已经是目标位置 → 无操作
        return;
      }
      const summary = entries.map(([o, n]) => `  ${o} → ${n}`).join('\n');
      const targetLabel = newParentId === null ? '(top-level)' : newParentId;
      const ok = await dialog.confirm(
        `Move ${sourceId} under ${targetLabel}?\n\n${entries.length} card${entries.length === 1 ? '' : 's'} will be renumbered:\n${summary}`,
        {
          title: 'Reparent + renumber',
          description:
            'All [[link]] references and workspace card references to renamed ids will be rewritten too.',
          confirmLabel: 'Reparent',
          variant: 'danger',
        },
      );
      if (!ok) return;
      const result = await api.reparentCard(sourceId, newParentId, { dryRun: false });
      // id 大改 → 整个 cache 都不可信，全清
      qc.invalidateQueries();
      usePaneStore.getState().renameCardRefs(result.renames);
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Reparent failed' });
    }
  };

  const handleDeleteCard = async (id: string) => {
    const card = (cardsQ.data?.cards ?? []).find((c) => c.luhmannId === id);
    const ok = await dialog.confirm(`Delete ${id}?`, {
      title: card ? `Delete "${card.title}"` : 'Delete card',
      description:
        'The .md file will be removed and crossLinks from other cards cleaned up. ⌘Z to undo.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await deleteMut.mutateAsync(id);
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Delete failed' });
    }
  };
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
      qc.refetchQueries({ queryKey: ['resources'] }),
    ]);
  };
  const renameTagMut = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      api.renameTag(oldName, newName),
    onSuccess: invalidateAfterTagOp,
  });
  const deleteTagMut = useMutation({
    mutationFn: (name: string) => api.deleteTag(name),
    onSuccess: async (_data, name) => {
      await invalidateAfterTagOp();
      usePaneStore
        .getState()
        .removeTabsWhere((t) => t.kind === 'tag' && t.tagName === name);
    },
  });

  // Folgezettel 树：包含所有非 daily 卡。顶级（1/2/3...）自然作为 root。
  // Master 不再是某张卡 —— 是 Sidebar 顶部的"Vault"标题这个虚拟入口。
  const folgezettelTree = useMemo(() => {
    const allCards = cardsQ.data?.cards ?? [];
    const dailyRe = /^daily(\d{8})/;
    const exclude = new Set<string>();
    for (const c of allCards) if (dailyRe.test(c.luhmannId)) exclude.add(c.luhmannId);
    return buildFolgezettelTree(allCards, exclude);
  }, [cardsQ.data]);

  const dailies = useMemo(() => {
    const allCards = cardsQ.data?.cards ?? [];
    const dailyRe = /^daily(\d{8})$/;
    return allCards
      .filter((c) => dailyRe.test(c.luhmannId))
      .sort((a, b) => b.luhmannId.localeCompare(a.luhmannId));
  }, [cardsQ.data]);
  void indexesQ; // 保留 query（其他地方用）但 sidebar 不再用 INDEXES 树了

  return (
    <aside className="w-72 h-full border-r border-gray-200 bg-white dark:bg-[#1e2030] dark:border-[#363a4f] flex flex-col">
      <header className="h-12 px-5 flex items-center border-b border-gray-100">
        <span className="font-bold text-sm tracking-tight">{t('sidebar.vault', {}, language)}</span>
      </header>

      {/* Master 按钮：vault 入口。Master 是个虚拟 box，只装顶级 index 卡（1/2/3...） */}
      <div
        className={`flex items-center gap-2 px-5 py-2.5 border-b border-gray-100 dark:border-[#363a4f] hover:bg-amber-50 dark:hover:bg-amber-900/10 group transition-colors ${
          focusedBoxId === MASTER_BOX_ID ? 'bg-amber-50 dark:bg-amber-900/10' : ''
        }`}
      >
        <button
          onClick={() => {
            const isActive = focusedBoxId === MASTER_BOX_ID;
            openTabFromStore({
              kind: 'card',
              title: 'Master Index',
              cardBoxId: MASTER_BOX_ID,
              cardFocusId: MASTER_BOX_ID,
            });
            void isActive;
          }}
          className="min-w-0 flex-1 flex items-center gap-2 text-left"
          title={t('sidebar.masterIndex', {}, language)}
        >
          <Crown size={14} className="text-amber-500 shrink-0" />
          <span className="text-[12px] font-bold text-ink dark:text-[#cad3f5] flex-1">
            {t('sidebar.masterIndex', {}, language)}
          </span>
          <span className="text-[10px] text-gray-400 group-hover:text-amber-600">→</span>
        </button>
        <button
          onClick={() => {
            const nextId = nextTopLevelBoxId(cardsQ.data?.cards ?? []);
            openNewCard({
              luhmannId: nextId,
              title: `Index ${nextId}`,
              content: `# Index ${nextId}\n\n`,
            });
          }}
          className="shrink-0 p-1.5 rounded-md text-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
          title={t('sidebar.createTopBox', {}, language)}
        >
          <Plus size={14} strokeWidth={2.4} />
        </button>
      </div>

      {/* Starred: 顶部置顶 */}
      {(starredQ.data?.ids ?? []).length > 0 && (
        <Section icon={<Star size={12} />} title={t('sidebar.starred', {}, language)}>
          {(() => {
            const cardById = new Map((cardsQ.data?.cards ?? []).map((c) => [c.luhmannId, c]));
            const dailyRe = /^daily(\d{4})(\d{2})(\d{2})$/;
            return (starredQ.data?.ids ?? []).map((id) => {
              const c = cardById.get(id);
              const dailyMatch = id.match(dailyRe);
              const displayId = dailyMatch ? `${dailyMatch[1]}-${dailyMatch[2]}-${dailyMatch[3]}` : id;
              return (
                <button
                  key={id}
                  onClick={(e) => navigate(id, modifiersToOpts(e))}
                  className={`group w-full flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-gray-50 text-left min-w-0 ${
                    focusedId === id ? 'bg-accentSoft' : ''
                  }`}
                  title={c?.title ?? id}
                >
                  <Star size={10} className="text-amber-400 fill-amber-400 shrink-0" />
                  {/* id/日期：固定宽度太小 daily20260425 这种长 id 会撞标题。
                       daily 卡显示成 YYYY-MM-DD，普通卡用 max-w 限制 + truncate */}
                  <span className="font-mono text-[10px] text-gray-500 shrink-0 max-w-[80px] truncate">
                    {displayId}
                  </span>
                  <span className="text-[12px] truncate flex-1 min-w-0">
                    {c?.title ?? <span className="italic text-gray-400">missing</span>}
                  </span>
                </button>
              );
            });
          })()}
        </Section>
      )}

      {/* Folgezettel 树：自动按 id 算父子；顶级 luhmannId（1/2/3...）作为根节点。
           Master 是 Sidebar 顶部"Vault"标签这个虚拟概念，不再是某张卡。
           整个 Section 容器接 drop —— 拖到树空白处 = 提升为 top-level（newParentId=null） */}
      <div
        onDragOver={(e) => {
          if (!isCardDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          const dragged = readCardDragData(e);
          if (!dragged) return;
          // 只在事件没被某个 FolgezettelNode 截掉时才 fire（节点 onDrop 用 stopPropagation）
          e.preventDefault();
          reparentCard(dragged.luhmannId, null);
        }}
        className="contents"
      >
      <Section icon={<FolderTree size={12} />} title={t('sidebar.folgezettel', {}, language)} scroll>
        {(folgezettelTree.get(null) ?? []).length === 0 ? (
          <div className="text-[11px] text-gray-400 px-3 py-1.5 leading-relaxed">
            {t('sidebar.noCards', {}, language)}
          </div>
        ) : (
          (folgezettelTree.get(null) ?? []).map((id) => (
            <FolgezettelNode
              key={id}
              id={id}
              level={0}
              tree={folgezettelTree}
              cardById={new Map((cardsQ.data?.cards ?? []).map((c) => [c.luhmannId, c]))}
              focusedId={focusedId}
              focusedBoxId={focusedBoxId}
              onSelect={navigate}
              onDelete={handleDeleteCard}
              onReparent={reparentCard}
            />
          ))
        )}
      </Section>
      </div>

      {/* Tags: 内联 chips，自动换行；右键改名 */}
      <Section icon={<Tag size={12} />} title={t('sidebar.tags', {}, language)}>
        {(tagsQ.data?.tags ?? []).length === 0 ? (
          <div className="text-[11px] text-gray-400 px-3 py-1.5">{t('sidebar.noTags', {}, language)}</div>
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

      <Section icon={<PackageOpen size={12} />} title={t('sidebar.resources', {}, language)}>
        {(resourcesQ.data?.resources ?? []).length === 0 ? (
          <div className="text-[11px] text-gray-400 px-3 py-1.5">{t('sidebar.noResources', {}, language)}</div>
        ) : (
          <ChunkedList
            items={(resourcesQ.data?.resources ?? []).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))}
            initial={30}
            step={30}
            label="resources"
            render={(resource) => (
              <ResourceListItem key={resource.id} resource={resource} />
            )}
          />
        )}
      </Section>

      {/* DAILY: 最近的每日笔记，时间倒序 */}
      <Section icon={<CalendarDays size={12} />} title={t('sidebar.daily', {}, language)}>
        <DailyMiniCalendar
          dailies={dailies}
          focusedId={focusedId}
          onOpen={(date) => {
            void (async () => {
              try {
                const { luhmannId, created } = await api.openOrCreateDaily(date);
                if (created) {
                  qc.invalidateQueries({ queryKey: ['cards'] });
                  qc.invalidateQueries({ queryKey: ['indexes'] });
                  qc.invalidateQueries({ queryKey: ['tags'] });
                }
                navigate(luhmannId);
              } catch (err) {
                dialog.alert((err as Error).message, { title: 'Daily failed' });
              }
            })();
          }}
        />
      </Section>

      {/* 旧 ORPHANS section 移除 —— Folgezettel 树自动包含所有非 master 卡，
           没父的会作为 root 出现，不再需要单独 orphan 概念 */}

      <VaultPicker />
    </aside>
  );
}

function ResourceListItem({ resource }: { resource: ResourceCard }) {
  const language = useUIStore((s) => s.language);
  const workspaceOnly = !resource.parentBoxId;
  return (
    <div
      draggable
      onDragStart={(e) => setResourceDragData(e, { resourceId: resource.id, title: resource.title })}
      className={`group flex items-center gap-2 px-3 py-1.5 rounded-md text-left min-w-0 cursor-grab active:cursor-grabbing transition-colors ${
        workspaceOnly
          ? 'bg-[#fff6db]/70 hover:bg-[#f3e6c8] dark:bg-[#3a2f1f]/35 dark:hover:bg-[#4a3a22]/55'
          : 'hover:bg-gray-50 dark:hover:bg-[#24273a]'
      }`}
      title={`${resource.title} · ${resource.id}${workspaceOnly ? ' · workspace resource' : ''}`}
    >
      <span className={`text-[9px] font-black uppercase tracking-wider w-9 shrink-0 ${
        workspaceOnly ? 'text-[#9a6a2f] dark:text-[#eed49f]' : 'text-accent'
      }`}>
        {resource.kind}
      </span>
      <span className="text-[12px] truncate flex-1 min-w-0">{resource.title}</span>
      {workspaceOnly && (
        <span className="rounded-full bg-[#f3e6c8] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#9a6a2f] dark:bg-[#4a3a22] dark:text-[#eed49f]">
          {t('resource.workspaceOnly', {}, language)}
        </span>
      )}
      {resource.tags.length > 0 && (
        <span className="text-[10px] text-gray-400 shrink-0">#{resource.tags[0]}</span>
      )}
    </div>
  );
}

/** Folgezettel 自动树节点：递归渲染。父子关系来自 buildFolgezettelTree 算的 map */
function FolgezettelNode({
  id,
  level,
  tree,
  cardById,
  focusedId,
  focusedBoxId,
  onSelect,
  onDelete,
  onReparent,
}: {
  id: string;
  level: number;
  tree: Map<string | null, string[]>;
  cardById: Map<string, CardSummary>;
  focusedId: string | null;
  focusedBoxId: string | null;
  onSelect: (id: string, opts?: { newTab?: boolean; splitDirection?: 'horizontal' | 'vertical' }) => void;
  onDelete: (id: string) => void;
  onReparent: (sourceId: string, newParentId: string | null) => void;
}) {
  const card = cardById.get(id);
  const children = tree.get(id) ?? [];
  const [expanded, setExpanded] = useState(level < 1);
  const [dropOver, setDropOver] = useState(false);
  const hasChildren = children.length > 0;
  const isIndex = card?.status === 'INDEX';
  const highlighted = isIndex
    ? focusedBoxId === id
    : focusedId === id;
  return (
    <div>
      <div
        onDragOver={(e) => {
          // 注意：dragOver 阶段大多数浏览器禁止读 dataTransfer.getData，
          // 所以这里只用 .types 判断 mime；身份比对（同 id）等到 drop 才做。
          if (!isCardDrag(e)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          setDropOver(true);
        }}
        onDragLeave={() => setDropOver(false)}
        onDrop={(e) => {
          setDropOver(false);
          const dragged = readCardDragData(e);
          if (!dragged || dragged.luhmannId === id) return;
          e.preventDefault();
          e.stopPropagation();
          onReparent(dragged.luhmannId, id);
        }}
        className={`group flex items-center gap-1 rounded-md text-left hover:bg-gray-50 ${
          highlighted ? 'bg-accentSoft' : ''
        } ${dropOver ? 'ring-2 ring-accent ring-offset-1 bg-accentSoft' : ''}`}
        style={{ paddingLeft: 4 + level * 14 }}
      >
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 text-gray-400 hover:text-ink shrink-0"
          >
            <ChevronRight size={12} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span className="w-5" />
        )}
        <button
          onClick={(e) => onSelect(id, modifiersToOpts(e))}
          draggable={!!card}
          onDragStart={(e) => card && setCardDragData(e, { luhmannId: id, title: card.title })}
          className="flex-1 min-w-0 flex items-center gap-1.5 py-1.5 text-left cursor-grab active:cursor-grabbing"
          title={card ? `${id} · ${card.title}` : `${id} (missing)`}
        >
          <span
            className={`font-mono text-[9.5px] font-bold px-1 py-0.5 rounded shrink-0 ${
              isIndex ? 'bg-accent text-white' : 'bg-gray-100 text-gray-600'
            }`}
          >
            {id}
          </span>
          <span
            className={`text-[12px] truncate ${
              isIndex ? 'font-semibold text-ink' : 'text-gray-700'
            }`}
          >
            {card?.title ?? <span className="italic text-gray-400">missing</span>}
          </span>
        </button>
        {card && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(id);
            }}
            className="p-0.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            title={`Delete ${id}`}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      {expanded && hasChildren && (
        <div>
          {children.map((cid) => (
            <FolgezettelNode
              key={cid}
              id={cid}
              level={level + 1}
              tree={tree}
              cardById={cardById}
              focusedId={focusedId}
              focusedBoxId={focusedBoxId}
              onSelect={onSelect}
              onDelete={onDelete}
              onReparent={onReparent}
            />
          ))}
        </div>
      )}
    </div>
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

/**
 * 可折叠 Section：title 是 button，点了在 localStorage 里存 collapsed 状态。
 *  - scroll=true 的 section 折叠时变成只剩 header；展开时占 flex-1 并内部滚动
 *  - 其他 section 折叠时只剩 header；展开时自然撑高
 * 这样用户能折掉不常看的 section（比如 Tags 太多），把空间留给 Folgezettel 树。
 */
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
  const storageKey = title ? `sidebar.section.collapsed.${title}` : null;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (!storageKey) return false;
    try {
      return localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {}
    }
  };
  // collapsed → 把 flex-1 拿掉，shrink to header 高度
  const containerCls = scroll && !collapsed ? 'flex-1 overflow-y-auto min-h-0' : '';
  return (
    <div className={`border-b border-gray-100 ${containerCls}`}>
      {title ? (
        <button
          onClick={toggle}
          className="w-full flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-gray-400 px-5 py-2.5 hover:text-ink dark:hover:text-[#cad3f5] transition-colors"
          title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
        >
          <ChevronRight
            size={10}
            className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
          {icon}
          <span>{title}</span>
        </button>
      ) : null}
      {!collapsed && <div className="px-4 pb-3 space-y-0.5">{children}</div>}
    </div>
  );
}

/**
 * Daily 区的 mini 日历：当前月所有日期的 7 列网格 + 月份切换。
 *  - 有 daily 卡的日期 → accent 高亮
 *  - 今天 → 厚边框
 *  - 当前焦点 daily → bg-accent
 *  - 点任意日期 → 打开/创建该日 daily（onOpen 回调）
 *  顶部"Today"按钮直跳今天。
 */
function DailyMiniCalendar({
  dailies,
  focusedId,
  onOpen,
}: {
  dailies: CardSummary[];
  focusedId: string | null;
  onOpen: (date: string) => void;
}) {
  const today = useMemo(() => new Date(), []);
  const todayKey = ymd(today);
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });
  // dailies 按日期 key 索引
  const dailyByDate = useMemo(() => {
    const map = new Map<string, string>(); // 'YYYY-MM-DD' → luhmannId
    const re = /^daily(\d{4})(\d{2})(\d{2})$/;
    for (const c of dailies) {
      const m = c.luhmannId.match(re);
      if (m) map.set(`${m[1]}-${m[2]}-${m[3]}`, c.luhmannId);
    }
    return map;
  }, [dailies]);

  // 当月日历网格：从本月 1 号所在周一开始，6 行 × 7 列
  const cells = useMemo(() => {
    const first = new Date(view.y, view.m, 1);
    const startDay = (first.getDay() + 6) % 7; // 周一为首
    const start = new Date(first);
    start.setDate(1 - startDay);
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(d);
    }
    return out;
  }, [view]);

  const monthLabel = `${view.y}-${String(view.m + 1).padStart(2, '0')}`;
  const focusedDateKey = (() => {
    if (!focusedId) return null;
    const m = focusedId.match(/^daily(\d{4})(\d{2})(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  })();

  return (
    <div className="space-y-2">
      <button
        onClick={() => onOpen(todayKey)}
        className="w-full text-[11px] font-bold px-3 py-1.5 rounded-md bg-accent text-white hover:bg-accent/90 shadow-sm"
      >
        Open today ({todayKey})
      </button>

      <div className="flex items-center justify-between text-[10px] font-bold text-gray-500 px-1">
        <button
          onClick={() => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { ...v, m: v.m - 1 }))}
          className="px-1 hover:text-ink dark:hover:text-[#cad3f5]"
          title="Previous month"
        >‹</button>
        <button
          onClick={() => setView({ y: today.getFullYear(), m: today.getMonth() })}
          className="hover:text-ink dark:hover:text-[#cad3f5]"
          title="Back to current month"
        >
          {monthLabel}
        </button>
        <button
          onClick={() => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { ...v, m: v.m + 1 }))}
          className="px-1 hover:text-ink dark:hover:text-[#cad3f5]"
          title="Next month"
        >›</button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 text-[9px]">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w, i) => (
          <div key={i} className="text-center text-gray-400 font-bold py-0.5">{w}</div>
        ))}
        {cells.map((d) => {
          const inMonth = d.getMonth() === view.m;
          const key = ymd(d);
          const has = dailyByDate.has(key);
          const isToday = key === todayKey;
          const isFocused = key === focusedDateKey;
          return (
            <button
              key={key}
              onClick={() => onOpen(key)}
              className={`text-center py-1 rounded transition-colors text-[10px] ${
                !inMonth ? 'text-gray-300 dark:text-gray-600' :
                isFocused ? 'bg-accent text-white' :
                has ? 'bg-accentSoft text-accent font-bold hover:bg-accent hover:text-white' :
                'text-gray-500 hover:bg-gray-100 dark:hover:bg-[#363a4f]'
              } ${isToday ? 'ring-1 ring-accent' : ''}`}
              title={key + (has ? ' · has daily' : '')}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
