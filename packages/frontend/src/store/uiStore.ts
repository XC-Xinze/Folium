import { create } from 'zustand';

export type ViewMode = 'chain' | 'graph' | 'settings' | 'tag';

interface UIState {
  /** 当前在哪个盒子里——决定画布展示哪棵树 */
  focusedBoxId: string | null;
  /** 此刻关注哪张卡——决定哪张卡有焦点高亮 */
  focusedCardId: string | null;
  focusedTag: string | null;
  viewMode: ViewMode;
  showPotential: boolean;
  /** 仅更新焦点卡（box 不变，适合点 ATOMIC） */
  setFocus: (id: string | null) => void;
  /** 同时更新 box 与 focus（适合点 INDEX 或显式切盒子） */
  setBoxAndFocus: (boxId: string, cardId?: string) => void;
  setFocusTag: (tag: string | null) => void;
  setViewMode: (m: ViewMode) => void;
  setShowPotential: (b: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  focusedBoxId: null,
  focusedCardId: null,
  focusedTag: null,
  viewMode: 'chain',
  showPotential: true,
  setFocus: (id) => set({ focusedCardId: id, viewMode: 'chain', focusedTag: null }),
  setBoxAndFocus: (boxId, cardId) =>
    set({
      focusedBoxId: boxId,
      focusedCardId: cardId ?? boxId,
      viewMode: 'chain',
      focusedTag: null,
    }),
  setFocusTag: (tag) => set({ focusedTag: tag, viewMode: tag ? 'tag' : 'chain' }),
  setViewMode: (m) => set({ viewMode: m }),
  setShowPotential: (b) => set({ showPotential: b }),
}));
