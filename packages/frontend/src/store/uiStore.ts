import { create } from 'zustand';

export type ViewMode = 'chain' | 'graph' | 'settings' | 'tag' | 'workspace';

interface UIState {
  focusedBoxId: string | null;
  focusedCardId: string | null;
  focusedTag: string | null;
  /** 当前打开的 workspace id（决定主区显示哪个 workspace） */
  focusedWorkspaceId: string | null;
  viewMode: ViewMode;
  showPotential: boolean;
  setFocus: (id: string | null) => void;
  setBoxAndFocus: (boxId: string, cardId?: string) => void;
  setFocusTag: (tag: string | null) => void;
  setFocusWorkspace: (id: string | null) => void;
  setViewMode: (m: ViewMode) => void;
  setShowPotential: (b: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  focusedBoxId: null,
  focusedCardId: null,
  focusedTag: null,
  focusedWorkspaceId: null,
  viewMode: 'chain',
  showPotential: true,
  setFocus: (id) =>
    set({ focusedCardId: id, viewMode: 'chain', focusedTag: null, focusedWorkspaceId: null }),
  setBoxAndFocus: (boxId, cardId) =>
    set({
      focusedBoxId: boxId,
      focusedCardId: cardId ?? boxId,
      viewMode: 'chain',
      focusedTag: null,
      focusedWorkspaceId: null,
    }),
  setFocusTag: (tag) =>
    set({ focusedTag: tag, viewMode: tag ? 'tag' : 'chain', focusedWorkspaceId: null }),
  setFocusWorkspace: (id) =>
    set({ focusedWorkspaceId: id, viewMode: id ? 'workspace' : 'chain' }),
  setViewMode: (m) => set({ viewMode: m }),
  setShowPotential: (b) => set({ showPotential: b }),
}));
