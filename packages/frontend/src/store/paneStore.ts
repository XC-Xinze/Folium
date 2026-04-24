import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Obsidian 风的窗口管理：root 是 pane 树（叶子是 LeafPane，分支是 SplitPane）。
 *
 * 每个叶子 pane 装多个 tab，每个 tab 内容由 kind + payload 决定。
 * Split 是二叉的（左右或上下），ratio ∈ (0,1)。
 */

export type TabKind = 'card' | 'graph' | 'tag' | 'settings' | 'workspace';

export interface Tab {
  /** tab 自己的 id（与内容无关，用于身份标识） */
  id: string;
  kind: TabKind;
  /** 显示用的标题（render 时也可以从 payload 推导） */
  title: string;
  // ── kind 相关 payload ──
  cardBoxId?: string;
  cardFocusId?: string;
  tagName?: string;
  workspaceId?: string;
}

export interface LeafPane {
  kind: 'leaf';
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
}

export interface SplitPane {
  kind: 'split';
  id: string;
  direction: 'horizontal' | 'vertical'; // horizontal = 左右，vertical = 上下
  children: [Pane, Pane];
  ratio: number; // 0..1, 第一个孩子占比
}

export type Pane = LeafPane | SplitPane;

interface PaneStateData {
  root: Pane;
  /** 当前焦点 leaf pane id —— 新 tab 默认开在这里 */
  activeLeafId: string;
}

interface PaneActions {
  /** 在 active leaf 里开 tab；如果同 kind+payload 已存在，激活而非新建 */
  openTab: (
    spec: Omit<Tab, 'id'>,
    opts?: { newTab?: boolean; splitDirection?: 'horizontal' | 'vertical' },
  ) => void;
  /** 在指定 pane 里开 */
  openTabIn: (paneId: string, spec: Omit<Tab, 'id'>, opts?: { newTab?: boolean }) => void;
  closeTab: (paneId: string, tabId: string) => void;
  setActiveTab: (paneId: string, tabId: string) => void;
  setActiveLeaf: (paneId: string) => void;
  splitPane: (
    paneId: string,
    direction: 'horizontal' | 'vertical',
    spec?: Omit<Tab, 'id'>,
  ) => void;
  setRatio: (splitId: string, ratio: number) => void;
  reorderTab: (paneId: string, fromIdx: number, toIdx: number) => void;
  /** 在 tab 上更新 payload —— 用于 box/focus 切换不开新 tab */
  updateTab: (paneId: string, tabId: string, patch: Partial<Tab>) => void;
  /** 强制关掉一个 pane（无视它有几个 tab）—— 唯一 leaf 时退化成空 leaf */
  removeEmptyPane: (paneId: string) => void;
  /** 重置成单 pane 单空 tab */
  reset: () => void;
}

type PaneStore = PaneStateData & PaneActions;

let _id = 0;
function uid(): string {
  // 单调 id，足够会话内唯一；持久化时 hydrate 跟随
  _id += 1;
  return `${Date.now().toString(36)}-${_id.toString(36)}`;
}

function emptyLeaf(): LeafPane {
  return { kind: 'leaf', id: uid(), tabs: [], activeTabId: null };
}

const INITIAL: PaneStateData = (() => {
  const leaf = emptyLeaf();
  return { root: leaf, activeLeafId: leaf.id };
})();

// ── 树辅助 ──

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

function findParent(root: Pane, childId: string): SplitPane | null {
  if (root.kind === 'leaf') return null;
  for (const c of root.children) {
    if (c.id === childId) return root;
    const r = findParent(c, childId);
    if (r) return r;
  }
  return null;
}

function findById(node: Pane, id: string): Pane | null {
  if (node.id === id) return node;
  if (node.kind === 'split') {
    for (const c of node.children) {
      const r = findById(c, id);
      if (r) return r;
    }
  }
  return null;
}

/** 删除一个 leaf pane —— 把它的兄弟提升到 parent 的位置 */
function removeLeaf(root: Pane, leafId: string): { root: Pane; nextActive: string } {
  if (root.kind === 'leaf') {
    // 不能删唯一 leaf —— 留个空的
    return { root: emptyLeaf(), nextActive: root.id };
  }
  const parent = findParent(root, leafId);
  if (!parent) return { root, nextActive: leafId };
  const sibling = parent.children[0].id === leafId ? parent.children[1] : parent.children[0];

  // 替换 parent 为 sibling
  const replaceInTree = (node: Pane): Pane => {
    if (node.kind === 'leaf') return node;
    if (node.id === parent.id) return sibling;
    return {
      ...node,
      children: [replaceInTree(node.children[0]), replaceInTree(node.children[1])],
    };
  };
  const nextRoot = replaceInTree(root);
  const nextActive = findFirstLeaf(sibling).id;
  return { root: nextRoot, nextActive };
}

function tabsEqual(a: Omit<Tab, 'id'>, b: Tab): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'card':
      return a.cardBoxId === b.cardBoxId && a.cardFocusId === b.cardFocusId;
    case 'tag':
      return a.tagName === b.tagName;
    case 'workspace':
      return a.workspaceId === b.workspaceId;
    case 'graph':
    case 'settings':
      return true;
  }
}

function makeTab(spec: Omit<Tab, 'id'>): Tab {
  return { ...spec, id: uid() };
}

// 不可变更新：返回新树
function mapTree(node: Pane, fn: (n: Pane) => Pane): Pane {
  const next = fn(node);
  if (next.kind === 'split') {
    return { ...next, children: [mapTree(next.children[0], fn), mapTree(next.children[1], fn)] };
  }
  return next;
}

export const usePaneStore = create<PaneStore>()(
  persist(
    (set, get) => ({
      ...INITIAL,

      openTab: (spec, opts) => {
        const { activeLeafId, root } = get();
        const leaf = findLeaf(root, activeLeafId) ?? findFirstLeaf(root);

        if (opts?.splitDirection) {
          get().splitPane(leaf.id, opts.splitDirection, spec);
          return;
        }

        // 已有同 kind+payload 的 tab → 激活，不新建
        const existing = leaf.tabs.find((t) => tabsEqual(spec, t));
        if (existing && !opts?.newTab) {
          set({
            root: mapTree(root, (n) =>
              n.kind === 'leaf' && n.id === leaf.id ? { ...n, activeTabId: existing.id } : n,
            ),
            activeLeafId: leaf.id,
          });
          return;
        }

        const newTab = makeTab(spec);
        const replace = !opts?.newTab && leaf.tabs.length === 1 && leaf.tabs[0]?.id === leaf.activeTabId;

        set({
          root: mapTree(root, (n) => {
            if (n.kind !== 'leaf' || n.id !== leaf.id) return n;
            if (replace) {
              return { ...n, tabs: [newTab], activeTabId: newTab.id };
            }
            return { ...n, tabs: [...n.tabs, newTab], activeTabId: newTab.id };
          }),
          activeLeafId: leaf.id,
        });
      },

      openTabIn: (paneId, spec, opts) => {
        const { root } = get();
        const leaf = findLeaf(root, paneId);
        if (!leaf) return;
        const existing = leaf.tabs.find((t) => tabsEqual(spec, t));
        if (existing && !opts?.newTab) {
          set({
            root: mapTree(root, (n) =>
              n.kind === 'leaf' && n.id === paneId ? { ...n, activeTabId: existing.id } : n,
            ),
            activeLeafId: paneId,
          });
          return;
        }
        const newTab = makeTab(spec);
        set({
          root: mapTree(root, (n) =>
            n.kind === 'leaf' && n.id === paneId
              ? { ...n, tabs: [...n.tabs, newTab], activeTabId: newTab.id }
              : n,
          ),
          activeLeafId: paneId,
        });
      },

      closeTab: (paneId, tabId) => {
        const { root, activeLeafId } = get();
        const leaf = findLeaf(root, paneId);
        if (!leaf) return;
        const idx = leaf.tabs.findIndex((t) => t.id === tabId);
        if (idx < 0) return;
        const remaining = leaf.tabs.filter((t) => t.id !== tabId);

        if (remaining.length === 0) {
          // 整个 pane 删掉（除非它是 root 的唯一 leaf）
          const onlyLeaf = root.kind === 'leaf' && root.id === paneId;
          if (onlyLeaf) {
            set({
              root: { ...leaf, tabs: [], activeTabId: null },
              activeLeafId: paneId,
            });
            return;
          }
          const { root: nextRoot, nextActive } = removeLeaf(root, paneId);
          set({
            root: nextRoot,
            activeLeafId: activeLeafId === paneId ? nextActive : activeLeafId,
          });
          return;
        }

        const nextActiveId =
          leaf.activeTabId === tabId
            ? remaining[Math.min(idx, remaining.length - 1)]!.id
            : leaf.activeTabId;
        set({
          root: mapTree(root, (n) =>
            n.kind === 'leaf' && n.id === paneId
              ? { ...n, tabs: remaining, activeTabId: nextActiveId }
              : n,
          ),
        });
      },

      setActiveTab: (paneId, tabId) => {
        const { root } = get();
        set({
          root: mapTree(root, (n) =>
            n.kind === 'leaf' && n.id === paneId ? { ...n, activeTabId: tabId } : n,
          ),
          activeLeafId: paneId,
        });
      },

      setActiveLeaf: (paneId) => set({ activeLeafId: paneId }),

      splitPane: (paneId, direction, spec) => {
        const { root } = get();
        const leaf = findLeaf(root, paneId);
        if (!leaf) return;
        const newLeaf: LeafPane = emptyLeaf();
        if (spec) {
          const newTab = makeTab(spec);
          newLeaf.tabs.push(newTab);
          newLeaf.activeTabId = newTab.id;
        }
        const splitId = uid();
        const split: SplitPane = {
          kind: 'split',
          id: splitId,
          direction,
          children: [leaf, newLeaf],
          ratio: 0.5,
        };

        const replaceInTree = (node: Pane): Pane => {
          if (node.kind === 'leaf') return node.id === paneId ? split : node;
          return {
            ...node,
            children: [replaceInTree(node.children[0]), replaceInTree(node.children[1])],
          };
        };
        set({ root: replaceInTree(root), activeLeafId: newLeaf.id });
      },

      setRatio: (splitId, ratio) => {
        const { root } = get();
        const clamped = Math.min(0.85, Math.max(0.15, ratio));
        const apply = (node: Pane): Pane => {
          if (node.kind === 'leaf') return node;
          if (node.id === splitId) return { ...node, ratio: clamped };
          return { ...node, children: [apply(node.children[0]), apply(node.children[1])] };
        };
        set({ root: apply(root) });
      },

      reorderTab: (paneId, fromIdx, toIdx) => {
        const { root } = get();
        set({
          root: mapTree(root, (n) => {
            if (n.kind !== 'leaf' || n.id !== paneId) return n;
            if (fromIdx === toIdx) return n;
            const next = n.tabs.slice();
            const [moved] = next.splice(fromIdx, 1);
            if (moved) next.splice(toIdx, 0, moved);
            return { ...n, tabs: next };
          }),
        });
      },

      updateTab: (paneId, tabId, patch) => {
        const { root } = get();
        set({
          root: mapTree(root, (n) =>
            n.kind === 'leaf' && n.id === paneId
              ? {
                  ...n,
                  tabs: n.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
                }
              : n,
          ),
        });
      },

      removeEmptyPane: (paneId) => {
        const { root, activeLeafId } = get();
        // 唯一 leaf —— 不能真删，清空 tabs 即可
        if (root.kind === 'leaf' && root.id === paneId) {
          set({ root: { ...root, tabs: [], activeTabId: null } });
          return;
        }
        const { root: nextRoot, nextActive } = removeLeaf(root, paneId);
        set({
          root: nextRoot,
          activeLeafId: activeLeafId === paneId ? nextActive : activeLeafId,
        });
      },

      reset: () => set(INITIAL),
    }),
    {
      name: 'zk-panes-v1',
      partialize: (s) => ({ root: s.root, activeLeafId: s.activeLeafId }),
      // hydrate 后保证 activeLeafId 仍然指向有效 leaf
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const leaf = findLeaf(state.root, state.activeLeafId);
        if (!leaf) {
          state.activeLeafId = findFirstLeaf(state.root).id;
        }
      },
    },
  ),
);

// ── selectors / 工具 ──

export function getActiveLeaf(s: PaneStateData): LeafPane {
  return findLeaf(s.root, s.activeLeafId) ?? findFirstLeaf(s.root);
}

export function getActiveTab(s: PaneStateData): Tab | null {
  const leaf = getActiveLeaf(s);
  return leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? null;
}

export const _internal = { findLeaf, findFirstLeaf, findById, mapTree, removeLeaf, tabsEqual };
