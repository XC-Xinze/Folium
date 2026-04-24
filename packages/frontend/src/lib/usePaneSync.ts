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
