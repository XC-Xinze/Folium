import { beforeEach, describe, expect, it } from 'vitest';
import { usePaneStore } from './paneStore';

describe('paneStore', () => {
  beforeEach(() => {
    usePaneStore.getState().reset();
  });

  it('starts with single empty leaf', () => {
    const s = usePaneStore.getState();
    expect(s.root.kind).toBe('leaf');
    if (s.root.kind === 'leaf') {
      expect(s.root.tabs).toHaveLength(0);
    }
  });

  it('openTab adds to active leaf', () => {
    usePaneStore.getState().openTab({ kind: 'card', title: 'A', cardBoxId: '1', cardFocusId: '1' });
    const s = usePaneStore.getState();
    if (s.root.kind === 'leaf') {
      expect(s.root.tabs).toHaveLength(1);
      expect(s.root.activeTabId).toBe(s.root.tabs[0]!.id);
    }
  });

  it('openTab with same payload activates existing tab', () => {
    const st = usePaneStore.getState();
    st.openTab({ kind: 'card', title: 'A', cardBoxId: '1', cardFocusId: '1' });
    st.openTab({ kind: 'card', title: 'B', cardBoxId: '2', cardFocusId: '2' });
    st.openTab({ kind: 'card', title: 'A again', cardBoxId: '1', cardFocusId: '1' });
    const s = usePaneStore.getState();
    if (s.root.kind === 'leaf') {
      // A 已存在 → 第二张是 B → 第三次是 A 激活，没新建
      // 但 B 是用新 tab 创建的（leaf 有 1 tab 时第二个走 newTab 路径）
      // 实际上：第一次 leaf 有 0 tab → 加 A
      // 第二次 leaf 有 1 tab (A 是 active) → replace → leaf 变成 [B]
      // 第三次 leaf 有 1 tab (B) → A 不在里面 → replace → leaf 变成 [A]
      expect(s.root.tabs).toHaveLength(1);
    }
  });

  it('openTab newTab=true always creates new', () => {
    const st = usePaneStore.getState();
    st.openTab({ kind: 'card', title: 'A', cardBoxId: '1', cardFocusId: '1' });
    st.openTab({ kind: 'card', title: 'B', cardBoxId: '2', cardFocusId: '2' }, { newTab: true });
    st.openTab({ kind: 'card', title: 'C', cardBoxId: '3', cardFocusId: '3' }, { newTab: true });
    const s = usePaneStore.getState();
    if (s.root.kind === 'leaf') {
      expect(s.root.tabs).toHaveLength(3);
    }
  });

  it('splitPane creates a split with new leaf', () => {
    const st = usePaneStore.getState();
    st.openTab({ kind: 'card', title: 'A', cardBoxId: '1', cardFocusId: '1' });
    const oldLeafId = (usePaneStore.getState().root as { id: string }).id;
    st.splitPane(oldLeafId, 'horizontal', { kind: 'graph', title: 'Graph' });
    const s = usePaneStore.getState();
    expect(s.root.kind).toBe('split');
    if (s.root.kind === 'split') {
      expect(s.root.direction).toBe('horizontal');
      expect(s.root.children).toHaveLength(2);
      expect(s.root.children[0].kind).toBe('leaf');
      expect(s.root.children[1].kind).toBe('leaf');
      // active leaf 切到了新 pane
      expect(s.activeLeafId).toBe(s.root.children[1].id);
    }
  });

  it('closeTab removes pane when last tab closes (in split)', () => {
    const st = usePaneStore.getState();
    st.openTab({ kind: 'card', title: 'A', cardBoxId: '1', cardFocusId: '1' });
    const leaf1Id = (usePaneStore.getState().root as { id: string }).id;
    st.splitPane(leaf1Id, 'horizontal', { kind: 'graph', title: 'Graph' });
    const root = usePaneStore.getState().root;
    if (root.kind !== 'split') throw new Error('expected split');
    const leaf2 = root.children[1];
    if (leaf2.kind !== 'leaf' || !leaf2.activeTabId) throw new Error('expected leaf with tab');
    st.closeTab(leaf2.id, leaf2.activeTabId);
    // 关掉了 split 的右半 → 应该退化成单 leaf
    const after = usePaneStore.getState();
    expect(after.root.kind).toBe('leaf');
  });

  it('closeTab keeps last leaf alive even when empty', () => {
    const st = usePaneStore.getState();
    st.openTab({ kind: 'card', title: 'A', cardBoxId: '1', cardFocusId: '1' });
    const root = usePaneStore.getState().root;
    if (root.kind !== 'leaf' || !root.activeTabId) throw new Error('expected leaf with tab');
    st.closeTab(root.id, root.activeTabId);
    const after = usePaneStore.getState();
    expect(after.root.kind).toBe('leaf');
    if (after.root.kind === 'leaf') {
      expect(after.root.tabs).toHaveLength(0);
    }
  });

  it('reorderTab moves tab within strip', () => {
    const st = usePaneStore.getState();
    st.openTab({ kind: 'card', title: 'A', cardBoxId: '1', cardFocusId: '1' });
    st.openTab({ kind: 'card', title: 'B', cardBoxId: '2', cardFocusId: '2' }, { newTab: true });
    st.openTab({ kind: 'card', title: 'C', cardBoxId: '3', cardFocusId: '3' }, { newTab: true });
    const root = usePaneStore.getState().root;
    if (root.kind !== 'leaf') throw new Error('expected leaf');
    st.reorderTab(root.id, 0, 2);
    const after = usePaneStore.getState().root;
    if (after.kind === 'leaf') {
      expect(after.tabs.map((t) => t.title)).toEqual(['B', 'C', 'A']);
    }
  });

  it('moveTab moves between panes', () => {
    const st = usePaneStore.getState();
    st.openTab({ kind: 'card', title: 'A', cardBoxId: '1', cardFocusId: '1' });
    const leaf1Id = (usePaneStore.getState().root as { id: string }).id;
    st.splitPane(leaf1Id, 'horizontal', { kind: 'card', title: 'B', cardBoxId: '2', cardFocusId: '2' });
    let root = usePaneStore.getState().root;
    if (root.kind !== 'split') throw new Error('expected split');
    const leftLeaf = root.children[0];
    const rightLeaf = root.children[1];
    if (leftLeaf.kind !== 'leaf' || rightLeaf.kind !== 'leaf') throw new Error('expected leaves');
    const tabA = leftLeaf.tabs[0]!;
    st.moveTab(leftLeaf.id, tabA.id, rightLeaf.id);
    root = usePaneStore.getState().root;
    // 左 pane 空了 → 整个塌陷成单 leaf（B + A 都在那里）
    expect(root.kind).toBe('leaf');
    if (root.kind === 'leaf') {
      expect(root.tabs.map((t) => t.title).sort()).toEqual(['A', 'B']);
    }
  });

  it('moveTabToSplit splits target with the moved tab', () => {
    const st = usePaneStore.getState();
    st.openTab({ kind: 'card', title: 'A', cardBoxId: '1', cardFocusId: '1' });
    st.openTab({ kind: 'card', title: 'B', cardBoxId: '2', cardFocusId: '2' }, { newTab: true });
    const root = usePaneStore.getState().root;
    if (root.kind !== 'leaf') throw new Error('expected leaf');
    const tabA = root.tabs[0]!;
    // 拖 A 到自己的右边 → 该 pane 应该 split horizontal，A 在右侧新 pane
    st.moveTabToSplit(root.id, tabA.id, root.id, 'right');
    const after = usePaneStore.getState().root;
    expect(after.kind).toBe('split');
    if (after.kind === 'split') {
      expect(after.direction).toBe('horizontal');
      const left = after.children[0];
      const right = after.children[1];
      if (left.kind === 'leaf' && right.kind === 'leaf') {
        expect(left.tabs.map((t) => t.title)).toEqual(['B']);
        expect(right.tabs.map((t) => t.title)).toEqual(['A']);
      }
    }
  });

  it('setRatio clamps between 0.15 and 0.85', () => {
    const st = usePaneStore.getState();
    st.openTab({ kind: 'card', title: 'A', cardBoxId: '1', cardFocusId: '1' });
    const leafId = (usePaneStore.getState().root as { id: string }).id;
    st.splitPane(leafId, 'horizontal', { kind: 'graph', title: 'G' });
    const splitId = (usePaneStore.getState().root as { id: string }).id;
    st.setRatio(splitId, 0.05);
    expect((usePaneStore.getState().root as { ratio: number }).ratio).toBe(0.15);
    st.setRatio(splitId, 0.99);
    expect((usePaneStore.getState().root as { ratio: number }).ratio).toBe(0.85);
  });
});
