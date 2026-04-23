import { create } from 'zustand';

export type ViewMode = 'chain' | 'graph' | 'settings' | 'tag';

interface UIState {
  focusedBoxId: string | null;
  focusedCardId: string | null;
  focusedTag: string | null;
  /** 当前打开的 workspace id（在右侧面板里展示） */
  focusedWorkspaceId: string | null;
  /** workspace 是否全屏（true 时主视图被 workspace 覆盖；false 时 split 显示） */
  workspaceFullscreen: boolean;
  /** 左 sidebar 是否折叠 */
  leftSidebarCollapsed: boolean;
  viewMode: ViewMode;
  showPotential: boolean;
  setFocus: (id: string | null) => void;
  setBoxAndFocus: (boxId: string, cardId?: string) => void;
  setFocusTag: (tag: string | null) => void;
  setFocusWorkspace: (id: string | null) => void;
  setWorkspaceFullscreen: (b: boolean) => void;
  toggleLeftSidebar: () => void;
  setViewMode: (m: ViewMode) => void;
  setShowPotential: (b: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  focusedBoxId: null,
  focusedCardId: null,
  focusedTag: null,
  focusedWorkspaceId: null,
  workspaceFullscreen: false,
  leftSidebarCollapsed: false,
  viewMode: 'chain',
  showPotential: true,
  setFocus: (id) =>
    set({ focusedCardId: id, viewMode: 'chain', focusedTag: null }),
  setBoxAndFocus: (boxId, cardId) =>
    set({
      focusedBoxId: boxId,
      focusedCardId: cardId ?? boxId,
      viewMode: 'chain',
      focusedTag: null,
    }),
  setFocusTag: (tag) => set({ focusedTag: tag, viewMode: tag ? 'tag' : 'chain' }),
  setFocusWorkspace: (id) =>
    // 切换 workspace 总是回到 split 模式（不保留之前的 fullscreen）
    set({ focusedWorkspaceId: id, workspaceFullscreen: false }),
  setWorkspaceFullscreen: (b) => set({ workspaceFullscreen: b }),
  toggleLeftSidebar: () => set((s) => ({ leftSidebarCollapsed: !s.leftSidebarCollapsed })),
  setViewMode: (m) => set({ viewMode: m }),
  setShowPotential: (b) => set({ showPotential: b }),
}));
