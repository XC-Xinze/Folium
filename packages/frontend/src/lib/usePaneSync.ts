import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useUIStore } from '../store/uiStore';
import { usePaneStore, type LeafPane, type Pane } from '../store/paneStore';
import { api } from './api';

/**
 * 把"当前 active tab"同步到 uiStore，让那些还在读 uiStore.focusedCardId / focusedBoxId / focusedTag
 * 的老组件继续工作 —— 这是把 pane 系统嫁接到老架构上的桥。
 *
 * 反方向（uiStore 改 → pane 改）通过 useNavigateToCard 等显式入口完成。
 */
function findLeaf(node: Pane, id: string): LeafPane | null {
  if (node.kind === 'leaf') return node.id === id ? node : null;
  for (const c of node.children) {
    const r = findLeaf(c, id);
    if (r) return r;
  }
  return null;
}

function findFirstLeaf(node: Pane): LeafPane {
  if (node.kind === 'leaf') return node;
  return findFirstLeaf(node.children[0]);
}

export function usePaneSync(): void {
  const root = usePaneStore((s) => s.root);
  const activeLeafId = usePaneStore((s) => s.activeLeafId);
  const setBoxAndFocus = useUIStore((s) => s.setBoxAndFocus);
  const setFocusTag = useUIStore((s) => s.setFocusTag);
  const setViewMode = useUIStore((s) => s.setViewMode);

  useEffect(() => {
    const leaf = findLeaf(root, activeLeafId) ?? findFirstLeaf(root);
    const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
    if (!tab) return;
    if (tab.kind === 'card' && tab.cardBoxId && tab.cardFocusId) {
      setBoxAndFocus(tab.cardBoxId, tab.cardFocusId);
    } else if (tab.kind === 'tag' && tab.tagName) {
      setFocusTag(tab.tagName);
    }
    // viewMode 旧字段：仍然给老 hotkey 用，但布局不再依赖它
    switch (tab.kind) {
      case 'card':
      case 'page':
      case 'masonry':
        setViewMode('chain');
        break;
      case 'graph':
        setViewMode('graph');
        break;
      case 'tag':
        setViewMode('tag');
        break;
      case 'settings':
        setViewMode('settings');
        break;
      case 'workspace':
        // 没有专门的 workspace viewMode；退回 chain，让命令系统继续工作
        setViewMode('chain');
        break;
    }
  }, [root, activeLeafId, setBoxAndFocus, setFocusTag, setViewMode]);
}

/**
 * 启动种子：如果 pane 树是空的（没 tab），用第一张卡或第一个 INDEX 起一个 card tab。
 */
export function usePaneBootstrap(): void {
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const indexesQ = useQuery({ queryKey: ['indexes'], queryFn: api.listIndexes });
  const openTab = usePaneStore((s) => s.openTab);
  const root = usePaneStore((s) => s.root);

  useEffect(() => {
    // 只在 root 完全空（单 leaf 0 tab）的时候做种子
    if (root.kind !== 'leaf' || root.tabs.length > 0) return;
    const firstIndex = indexesQ.data?.tree[0]?.luhmannId;
    const firstCard = cardsQ.data?.cards[0]?.luhmannId;
    const firstId = firstIndex ?? firstCard;
    if (!firstId) return;
    const card = cardsQ.data?.cards.find((c) => c.luhmannId === firstId);
    openTab({
      kind: 'card',
      title: card?.title ?? firstId,
      cardBoxId: firstId,
      cardFocusId: firstId,
    });
  }, [root, cardsQ.data, indexesQ.data, openTab]);
}

/**
 * 启动时清掉持久化里指向已删 card / workspace / tag 的 tab。
 * 只在所有 query 都首次返回后跑一次（避免 loading 时误判全删）。
 */
export function useStaleTabCleanup(): void {
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const wsQ = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces });
  const tagsQ = useQuery({ queryKey: ['tags'], queryFn: api.listTags });
  const removeTabsWhere = usePaneStore((s) => s.removeTabsWhere);
  const ranRef = (function useOnceFlag() {
    return useRefBox();
  })();

  useEffect(() => {
    if (ranRef.value) return;
    if (!cardsQ.data || !wsQ.data || !tagsQ.data) return;
    ranRef.value = true;

    const cardIds = new Set(cardsQ.data.cards.map((c) => c.luhmannId));
    const wsIds = new Set(wsQ.data.workspaces.map((w) => w.id));
    const tagNames = new Set(tagsQ.data.tags.map((t) => t.name));

    removeTabsWhere((tab) => {
      if (tab.kind === 'card') {
        return !!(
          (tab.cardBoxId && !cardIds.has(tab.cardBoxId)) ||
          (tab.cardFocusId && !cardIds.has(tab.cardFocusId))
        );
      }
      if (tab.kind === 'page') return !!tab.pageCardId && !cardIds.has(tab.pageCardId);
      if (tab.kind === 'workspace') return !!tab.workspaceId && !wsIds.has(tab.workspaceId);
      if (tab.kind === 'tag') return !!tab.tagName && !tagNames.has(tab.tagName);
      return false;
    });
  }, [cardsQ.data, wsQ.data, tagsQ.data, removeTabsWhere, ranRef]);
}

// 极简的"会话内只跑一次"flag，避免 hot reload 重复
function useRefBox() {
  const ref = (window as unknown as { __zkCleanupRan?: { value: boolean } }).__zkCleanupRan;
  if (ref) return ref;
  const box = { value: false };
  (window as unknown as { __zkCleanupRan?: { value: boolean } }).__zkCleanupRan = box;
  return box;
}
