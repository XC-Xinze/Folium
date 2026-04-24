import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ViewMode = 'chain' | 'graph' | 'settings' | 'tag';

export type SidebarTab = 'vault' | 'workspaces';

export type WorkspacePanelPosition = 'right' | 'left' | 'top' | 'bottom';

interface UIState {
  focusedBoxId: string | null;
  focusedCardId: string | null;
  focusedTag: string | null;
  focusedWorkspaceId: string | null;
  workspaceFullscreen: boolean;
  /** workspace 面板在主区的哪个方向 */
  workspacePanelPosition: WorkspacePanelPosition;
  /** 面板大小（百分比 0-100，主轴方向占比） */
  workspacePanelSize: number;
  /** pin = 跨刷新自动恢复当前焦点工作区（默认关闭：刷新后面板关闭） */
  workspacePanelPinned: boolean;
  leftSidebarCollapsed: boolean;
  /** 左 sidebar 当前显示哪个 tab（受 ribbon 图标控制） */
  sidebarTab: SidebarTab;
  viewMode: ViewMode;
  showPotential: boolean;
  /** 是否显示绿色的 tag 共现边/节点 */
  showTagRelated: boolean;
  /** 是否显示紫色的手动 [[link]] cross-flank 边/节点 */
  showCrossLinks: boolean;
  setFocus: (id: string | null) => void;
  setBoxAndFocus: (boxId: string, cardId?: string) => void;
  setFocusTag: (tag: string | null) => void;
  setFocusWorkspace: (id: string | null) => void;
  setWorkspaceFullscreen: (b: boolean) => void;
  setWorkspacePanelPosition: (p: WorkspacePanelPosition) => void;
  setWorkspacePanelSize: (n: number) => void;
  toggleWorkspacePanelPinned: () => void;
  toggleLeftSidebar: () => void;
  setSidebarTab: (t: SidebarTab) => void;
  setViewMode: (m: ViewMode) => void;
  setShowPotential: (b: boolean) => void;
  setShowTagRelated: (b: boolean) => void;
  setShowCrossLinks: (b: boolean) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      focusedBoxId: null,
      focusedCardId: null,
      focusedTag: null,
      focusedWorkspaceId: null,
      workspaceFullscreen: false,
      workspacePanelPosition: 'right',
      workspacePanelSize: 45,
      workspacePanelPinned: false,
      leftSidebarCollapsed: false,
      sidebarTab: 'vault',
      viewMode: 'chain',
      showPotential: true,
      showTagRelated: true,
      showCrossLinks: true,
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
      setFocusWorkspace: (id) => set({ focusedWorkspaceId: id, workspaceFullscreen: false }),
      setWorkspaceFullscreen: (b) => set({ workspaceFullscreen: b }),
      setWorkspacePanelPosition: (p) => set({ workspacePanelPosition: p }),
      setWorkspacePanelSize: (n) => set({ workspacePanelSize: Math.max(20, Math.min(80, n)) }),
      toggleWorkspacePanelPinned: () =>
        set((s) => ({ workspacePanelPinned: !s.workspacePanelPinned })),
      toggleLeftSidebar: () => set((s) => ({ leftSidebarCollapsed: !s.leftSidebarCollapsed })),
      setSidebarTab: (t) => set({ sidebarTab: t, leftSidebarCollapsed: false }),
      setViewMode: (m) => set({ viewMode: m }),
      setShowPotential: (b) => set({ showPotential: b }),
      setShowTagRelated: (b) => set({ showTagRelated: b }),
      setShowCrossLinks: (b) => set({ showCrossLinks: b }),
    }),
    {
      name: 'zettel-ui',
      // 仅持久化布局类偏好；导航/焦点状态每次启动重置
      // pin 开启时，额外把焦点工作区也持久化，刷新后自动恢复
      partialize: (state) => ({
        leftSidebarCollapsed: state.leftSidebarCollapsed,
        sidebarTab: state.sidebarTab,
        workspacePanelPosition: state.workspacePanelPosition,
        workspacePanelSize: state.workspacePanelSize,
        workspacePanelPinned: state.workspacePanelPinned,
        showPotential: state.showPotential,
        showTagRelated: state.showTagRelated,
        showCrossLinks: state.showCrossLinks,
        ...(state.workspacePanelPinned && {
          focusedWorkspaceId: state.focusedWorkspaceId,
        }),
      }),
    },
  ),
);
