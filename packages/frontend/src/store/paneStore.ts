import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Obsidian 风的窗口管理：root 是 pane 树（叶子是 LeafPane，分支是 SplitPane）。
 *
 * 每个叶子 pane 装多个 tab，每个 tab 内容由 kind + payload 决定。
 * Split 是二叉的（左右或上下），ratio ∈ (0,1)。
 */

export type TabKind = 'card' | 'graph' | 'tag' | 'settings' | 'workspace';

/** 卡片 tab 的边类型显示开关 —— 每个 tab 独立 */
export interface CardDisplayFlags {
  potential: boolean;
  tag: boolean;
  cross: boolean;
  workspaceLinks: boolean;
}

export const DEFAULT_CARD_FLAGS: CardDisplayFlags = {
  potential: true,
  tag: true,
  cross: true,
  workspaceLinks: true,
};

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
  /** 仅 kind='card' 用：四个边类型开关。缺省走 DEFAULT_CARD_FLAGS */
  cardFlags?: Partial<CardDisplayFlags>;
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
  /** 最近关闭的 tab spec —— 用于 ⌘⇧T 恢复（栈顶=最近关的） */
  closedHistory: Omit<Tab, 'id'>[];
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
  /** 批量删除满足 pred 的 tab（删卡 / 删 workspace 后清理用） */
  removeTabsWhere: (pred: (tab: Tab) => boolean) => void;
  /** 恢复最近关闭的 tab —— 失败（栈空）时无 op */
  reopenLastClosed: () => void;
  /** 选 active leaf 的第 idx (0-based) tab；越界无 op */
  selectTabAt: (idx: number) => void;
  /** 关 active tab —— ⌘W 用 */
  closeActiveTab: () => void;
  /** 把 tab 从一个 pane 移到另一个 pane 的指定位置（同 pane 内 fromIdx→toIdx 也用这个） */
  moveTab: (
    fromPaneId: string,
    tabId: string,
    toPaneId: string,
    toIndex?: number,
  ) => void;
  /** 把 tab 拖到另一个 pane 的边缘，触发 split：fromTab 走到新 pane */
  moveTabToSplit: (
    fromPaneId: string,
    tabId: string,
    targetPaneId: string,
    side: 'top' | 'bottom' | 'left' | 'right',
  ) => void;
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
  return { root: leaf, activeLeafId: leaf.id, closedHistory: [] };
})();

const CLOSED_STACK_MAX = 20;

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

/** 用 replacement 替换树中 id 为 leafId 的 leaf；replacement 自身不被遍历 */
function replaceLeaf(node: Pane, leafId: string, replacement: Pane): Pane {
  if (node.kind === 'leaf') return node.id === leafId ? replacement : node;
  return {
    ...node,
    children: [
      replaceLeaf(node.children[0], leafId, replacement),
      replaceLeaf(node.children[1], leafId, replacement),
    ],
  };
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
        // Obsidian 风的"smart open"：
        //   - 显式 newTab=true → 永远新建
        //   - 同类型 active tab 存在 → 替换它（看 card→点 card 不会一直叠 tab）
        //   - 不同类型（card↔workspace 等）→ 新建（避免一点 workspace 就把 card 顶掉）
        //   - 没 active tab → 新建（空 pane 第一张）
        const activeTab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
        const sameKind = activeTab && activeTab.kind === spec.kind;
        const replace = !opts?.newTab && !!sameKind;

        set({
          root: mapTree(root, (n) => {
            if (n.kind !== 'leaf' || n.id !== leaf.id) return n;
            if (replace) {
              // 替换 active 那张 tab；其他 tab 保留
              return {
                ...n,
                tabs: n.tabs.map((t) => (t.id === activeTab!.id ? newTab : t)),
                activeTabId: newTab.id,
              };
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
        const { root, activeLeafId, closedHistory } = get();
        const leaf = findLeaf(root, paneId);
        if (!leaf) return;
        const idx = leaf.tabs.findIndex((t) => t.id === tabId);
        if (idx < 0) return;
        const closing = leaf.tabs[idx]!;
        const remaining = leaf.tabs.filter((t) => t.id !== tabId);

        // 把关掉的 tab 推进 closedHistory（不存 id，恢复时重发）
        const { id: _ignored, ...closingSpec } = closing;
        void _ignored;
        const nextHistory = [closingSpec, ...(closedHistory ?? [])].slice(0, CLOSED_STACK_MAX);

        if (remaining.length === 0) {
          const onlyLeaf = root.kind === 'leaf' && root.id === paneId;
          if (onlyLeaf) {
            set({
              root: { ...leaf, tabs: [], activeTabId: null },
              activeLeafId: paneId,
              closedHistory: nextHistory,
            });
            return;
          }
          const { root: nextRoot, nextActive } = removeLeaf(root, paneId);
          set({
            root: nextRoot,
            activeLeafId: activeLeafId === paneId ? nextActive : activeLeafId,
            closedHistory: nextHistory,
          });
          return;
        }

        // 关 active tab → 优先切到右邻居（被关那个的下一位），没右就切左
        const nextActiveId =
          leaf.activeTabId === tabId
            ? (remaining[idx] ?? remaining[idx - 1] ?? remaining[0])!.id
            : leaf.activeTabId;
        set({
          root: mapTree(root, (n) =>
            n.kind === 'leaf' && n.id === paneId
              ? { ...n, tabs: remaining, activeTabId: nextActiveId }
              : n,
          ),
          closedHistory: nextHistory,
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

      moveTab: (fromPaneId, tabId, toPaneId, toIndex) => {
        const { root, activeLeafId } = get();
        const fromLeaf = findLeaf(root, fromPaneId);
        const toLeaf = findLeaf(root, toPaneId);
        if (!fromLeaf || !toLeaf) return;
        const moving = fromLeaf.tabs.find((t) => t.id === tabId);
        if (!moving) return;

        // 同 pane 内 reorder
        if (fromPaneId === toPaneId) {
          const fromIdx = fromLeaf.tabs.indexOf(moving);
          const next = fromLeaf.tabs.slice();
          const [m] = next.splice(fromIdx, 1);
          const insertAt = toIndex == null ? next.length : Math.min(toIndex, next.length);
          if (m) next.splice(insertAt, 0, m);
          set({
            root: mapTree(root, (n) =>
              n.kind === 'leaf' && n.id === fromPaneId ? { ...n, tabs: next } : n,
            ),
          });
          return;
        }

        // 跨 pane 移动
        const fromTabsAfter = fromLeaf.tabs.filter((t) => t.id !== tabId);
        const fromActiveAfter =
          fromLeaf.activeTabId === tabId
            ? fromTabsAfter[0]?.id ?? null
            : fromLeaf.activeTabId;
        const insertAt =
          toIndex == null ? toLeaf.tabs.length : Math.min(toIndex, toLeaf.tabs.length);
        const toTabsAfter = toLeaf.tabs.slice();
        toTabsAfter.splice(insertAt, 0, moving);

        let nextRoot = mapTree(root, (n) => {
          if (n.kind !== 'leaf') return n;
          if (n.id === fromPaneId) {
            return { ...n, tabs: fromTabsAfter, activeTabId: fromActiveAfter };
          }
          if (n.id === toPaneId) {
            return { ...n, tabs: toTabsAfter, activeTabId: moving.id };
          }
          return n;
        });

        // 如果源 pane 现在空了，删掉它（除非是唯一 leaf）
        if (fromTabsAfter.length === 0) {
          const isOnly = nextRoot.kind === 'leaf' && nextRoot.id === fromPaneId;
          if (!isOnly) {
            const removed = removeLeaf(nextRoot, fromPaneId);
            nextRoot = removed.root;
          }
        }
        // 拖完之后焦点跟随 moved tab → 接收方 pane
        // 若源 pane 还在且原本是 active，则保持 active 在源；否则切到接收方
        const nextActiveLeaf =
          activeLeafId === fromPaneId && fromTabsAfter.length > 0 ? fromPaneId : toPaneId;
        set({ root: nextRoot, activeLeafId: nextActiveLeaf });
      },

      moveTabToSplit: (fromPaneId, tabId, targetPaneId, side) => {
        const { root, activeLeafId } = get();
        const fromLeaf = findLeaf(root, fromPaneId);
        const targetLeafOrig = findLeaf(root, targetPaneId);
        if (!fromLeaf || !targetLeafOrig) return;
        const moving = fromLeaf.tabs.find((t) => t.id === tabId);
        if (!moving) return;

        // 同 pane 单 tab 拖自己边缘 → 没意义
        if (fromPaneId === targetPaneId && fromLeaf.tabs.length === 1) return;

        const fromTabsAfter = fromLeaf.tabs.filter((t) => t.id !== tabId);
        const fromActiveAfter =
          fromLeaf.activeTabId === tabId
            ? fromTabsAfter[0]?.id ?? null
            : fromLeaf.activeTabId;

        // 同 pane 拖：target 也用更新后的 tabs
        const targetLeafFinal: LeafPane =
          fromPaneId === targetPaneId
            ? { ...targetLeafOrig, tabs: fromTabsAfter, activeTabId: fromActiveAfter }
            : targetLeafOrig;

        const newLeaf: LeafPane = {
          kind: 'leaf',
          id: uid(),
          tabs: [moving],
          activeTabId: moving.id,
        };
        const direction: 'horizontal' | 'vertical' =
          side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
        const newBefore = side === 'left' || side === 'top';
        const newSplit: SplitPane = {
          kind: 'split',
          id: uid(),
          direction,
          children: newBefore ? [newLeaf, targetLeafFinal] : [targetLeafFinal, newLeaf],
          ratio: 0.5,
        };

        // 用 replaceLeaf 把 targetPaneId 整个替换为 newSplit（不再被 mapTree 遍历）
        let nextRoot = replaceLeaf(root, targetPaneId, newSplit);

        // 不同 pane 时，还要单独更新源 pane 的 tabs
        if (fromPaneId !== targetPaneId) {
          nextRoot = mapTree(nextRoot, (n) =>
            n.kind === 'leaf' && n.id === fromPaneId
              ? { ...n, tabs: fromTabsAfter, activeTabId: fromActiveAfter }
              : n,
          );
          if (fromTabsAfter.length === 0) {
            const isOnly = nextRoot.kind === 'leaf' && nextRoot.id === fromPaneId;
            if (!isOnly) {
              const removed = removeLeaf(nextRoot, fromPaneId);
              nextRoot = removed.root;
            }
          }
        }

        set({ root: nextRoot, activeLeafId: newLeaf.id });
        void activeLeafId;
      },

      removeTabsWhere: (pred) => {
        const { root, activeLeafId } = get();

        // 1) 先清掉每个 leaf 里的 stale tab
        let nextRoot = mapTree(root, (n) => {
          if (n.kind !== 'leaf') return n;
          const filtered = n.tabs.filter((t) => !pred(t));
          if (filtered.length === n.tabs.length) return n;
          const stillActive =
            n.activeTabId && filtered.some((t) => t.id === n.activeTabId);
          return {
            ...n,
            tabs: filtered,
            activeTabId: stillActive ? n.activeTabId : filtered[0]?.id ?? null,
          };
        });

        // 2) 把所有空 leaf 折叠掉（保留唯一 leaf 即使空）
        const collectEmptyLeafIds = (node: Pane, out: string[]): void => {
          if (node.kind === 'leaf') {
            if (node.tabs.length === 0) out.push(node.id);
            return;
          }
          collectEmptyLeafIds(node.children[0], out);
          collectEmptyLeafIds(node.children[1], out);
        };
        const empties: string[] = [];
        collectEmptyLeafIds(nextRoot, empties);
        for (const emptyId of empties) {
          const isOnly = nextRoot.kind === 'leaf' && nextRoot.id === emptyId;
          if (isOnly) continue; // 留唯一 leaf
          const removed = removeLeaf(nextRoot, emptyId);
          nextRoot = removed.root;
        }

        // 3) activeLeafId 还在树里就保留，否则切到第一个 leaf
        const stillActive = findLeaf(nextRoot, activeLeafId) != null;
        set({
          root: nextRoot,
          activeLeafId: stillActive ? activeLeafId : findFirstLeaf(nextRoot).id,
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

      reopenLastClosed: () => {
        const { closedHistory } = get();
        if (closedHistory.length === 0) return;
        const [spec, ...rest] = closedHistory;
        if (!spec) return;
        set({ closedHistory: rest });
        // 用 newTab=true 避免覆盖当前 active
        get().openTab(spec, { newTab: true });
      },

      selectTabAt: (idx) => {
        const { root, activeLeafId } = get();
        const leaf = findLeaf(root, activeLeafId) ?? findFirstLeaf(root);
        const target = leaf.tabs[idx];
        if (!target) return;
        get().setActiveTab(leaf.id, target.id);
      },

      closeActiveTab: () => {
        const { root, activeLeafId } = get();
        const leaf = findLeaf(root, activeLeafId) ?? findFirstLeaf(root);
        if (!leaf.activeTabId) return;
        get().closeTab(leaf.id, leaf.activeTabId);
      },

      reset: () => set(INITIAL),
    }),
    {
      name: 'zk-panes-v1',
      partialize: (s) => ({
        root: s.root,
        activeLeafId: s.activeLeafId,
        closedHistory: s.closedHistory,
      }),
      // hydrate 后保证 activeLeafId 仍然指向有效 leaf；老版本可能没 closedHistory
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const leaf = findLeaf(state.root, state.activeLeafId);
        if (!leaf) {
          state.activeLeafId = findFirstLeaf(state.root).id;
        }
        if (!Array.isArray(state.closedHistory)) {
          state.closedHistory = [];
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
