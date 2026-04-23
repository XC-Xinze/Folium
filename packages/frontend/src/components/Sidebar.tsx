import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, FolderTree, Settings, Tag } from 'lucide-react';
import { api, type IndexNode } from '../lib/api';
import { useUIStore } from '../store/uiStore';
import { useNavigateToCard } from '../lib/useNavigateToCard';

export function Sidebar() {
  const navigate = useNavigateToCard();
  const setFocusTag = useUIStore((s) => s.setFocusTag);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const focusedId = useUIStore((s) => s.focusedCardId);
  const focusedBoxId = useUIStore((s) => s.focusedBoxId);
  const focusedTag = useUIStore((s) => s.focusedTag);

  const tagsQ = useQuery({ queryKey: ['tags'], queryFn: api.listTags });
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const indexesQ = useQuery({ queryKey: ['indexes'], queryFn: api.listIndexes });

  return (
    <aside className="w-72 h-full border-r border-gray-200 bg-white flex flex-col">
      <header className="h-12 px-5 flex items-center justify-between border-b border-gray-100">
        <span className="font-bold text-sm tracking-tight">Zettelkasten</span>
        <button
          onClick={() => setViewMode('settings')}
          className="text-gray-400 hover:text-ink"
          title="设置"
        >
          <Settings size={16} />
        </button>
      </header>

      {/* Indexes 树：顶部最重要 */}
      <Section icon={<FolderTree size={12} />} title="INDEXES">
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
            还没有索引卡。新建时把状态选为 Index，并在正文里 [[link]] 别的卡。
          </div>
        )}
      </Section>

      {/* Tags：竖向列表，按 count 降序 */}
      <Section icon={<Tag size={12} />} title="TAGS">
        {(tagsQ.data?.tags ?? []).length === 0 ? (
          <div className="text-[11px] text-gray-400 px-3 py-1.5">还没有标签</div>
        ) : (
          (tagsQ.data?.tags ?? [])
            .slice()
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
            .map((t) => (
              <button
                key={t.name}
                onClick={() => setFocusTag(t.name)}
                className={`group w-full flex items-center justify-between px-3 py-1.5 rounded-md text-left transition-colors ${
                  focusedTag === t.name
                    ? 'bg-accentSoft text-accent'
                    : 'hover:bg-gray-50 text-gray-700'
                }`}
                title={`查看 #${t.name} 下所有卡片`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`text-[10px] font-bold w-2.5 text-right ${
                      focusedTag === t.name ? 'text-accent' : 'text-gray-300 group-hover:text-accent'
                    }`}
                  >
                    #
                  </span>
                  <span className="text-[12px] truncate">{t.name}</span>
                </div>
                <span className="text-[10px] font-mono text-gray-400 tabular-nums shrink-0">
                  {t.count}
                </span>
              </button>
            ))
        )}
      </Section>

      {/* All Cards：底部 */}
      <Section title="ALL CARDS" scroll>
        {cardsQ.data?.cards.map((c) => (
          <button
            key={c.luhmannId}
            onClick={() => navigate(c.luhmannId)}
            className={`w-full flex items-center gap-3 px-3 py-1.5 rounded-md text-left hover:bg-gray-50 ${
              focusedId === c.luhmannId ? 'bg-accentSoft' : ''
            }`}
            style={{ paddingLeft: 12 + (c.depth - 1) * 12 }}
          >
            <span className="font-mono text-[10px] text-gray-500 w-12 shrink-0">{c.luhmannId}</span>
            <span className="text-[12px] truncate">{c.title}</span>
            {c.status === 'INDEX' && (
              <span className="text-[8px] font-bold text-accent ml-auto shrink-0">IDX</span>
            )}
          </button>
        ))}
      </Section>
    </aside>
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
  onSelect: (id: string) => void;
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
          onClick={() => onSelect(node.luhmannId)}
          className="flex-1 min-w-0 flex items-center gap-1.5 py-1.5 text-left"
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
