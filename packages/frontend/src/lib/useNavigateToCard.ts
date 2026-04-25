import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CardSummary } from './api';
import { useUIStore } from '../store/uiStore';
import { usePaneStore } from '../store/paneStore';

/** 推导 luhmannId 的父级（前端版本，与后端逻辑一致） */
function deriveParentId(luhmannId: string): string | null {
  if (luhmannId.length <= 1) return null;
  const lastChar = luhmannId.at(-1)!;
  const isLastDigit = /\d/.test(lastChar);
  for (let i = luhmannId.length - 2; i >= 0; i--) {
    const ch = luhmannId[i]!;
    const isDigit = /\d/.test(ch);
    if (isDigit !== isLastDigit) return luhmannId.slice(0, i + 1);
  }
  return null;
}

/** 找一张卡的 Folgezettel 根（沿父链一直爬到顶或爬到 vault 不存在的那个父）—— 严格按 id 算，不看 INDEX 引用 */
function findFolgezettelRoot(cardId: string, allCards: CardSummary[]): string {
  const cardSet = new Set(allCards.map((c) => c.luhmannId));
  let cur = cardId;
  while (true) {
    const parent = deriveParentId(cur);
    if (!parent) return cur; // 已经是顶层 luhmann id（如 5、6、7）
    if (!cardSet.has(parent)) return cur; // 父在 vault 里不存在 → cur 是该子树最顶
    cur = parent;
  }
}

/** 判断一张卡是否在某个 box 的可视范围内：
 *  - box 是 INDEX：cardId 在 INDEX.crossLinks 或它们的 Folgezettel 子树
 *  - box 是 atomic（用作 Folgezettel 根 box）：cardId 是该 root 自己或其 Folgezettel 子孙
 */
function isCardInBox(cardId: string, boxId: string, allCards: CardSummary[]): boolean {
  if (cardId === boxId) return true;
  const box = allCards.find((c) => c.luhmannId === boxId);
  if (!box) return false;
  if (box.status === 'INDEX') {
    const directRefs = new Set<string>(box.crossLinks);
    if (directRefs.has(cardId)) return true;
    let current = cardId;
    while (true) {
      const parent = deriveParentId(current);
      if (!parent) break;
      if (directRefs.has(parent)) return true;
      current = parent;
    }
    return false;
  }
  // atomic box：检查 cardId 是不是 boxId 的 Folgezettel 后代
  let current = cardId;
  while (true) {
    const parent = deriveParentId(current);
    if (!parent) return false;
    if (parent === boxId) return true;
    current = parent;
  }
}

/**
 * 统一的卡片导航：
 *   - 点 INDEX 卡 → 切换 box 和 focus
 *   - 点 ATOMIC 卡且在当前 box 内 → 只改 focus
 *   - 点 ATOMIC 卡但不在当前 box → 切到该卡的 primary box，并 focus
 */
export function useNavigateToCard() {
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const openTab = usePaneStore((s) => s.openTab);

  return useCallback(
    (id: string, opts?: { newTab?: boolean; splitDirection?: 'horizontal' | 'vertical' }) => {
      const allCards = cardsQ.data?.cards ?? [];
      const card = allCards.find((c) => c.luhmannId === id);
      const title = card?.title ?? id;
      let boxId: string;
      let focusId: string;

      if (!card) {
        boxId = id;
        focusId = id;
      } else if (card.status === 'INDEX') {
        boxId = id;
        focusId = id;
      } else {
        // ATOMIC：保留"在当前 box 内只动 focus"的语义
        const currentBox = useUIStore.getState().focusedBoxId;
        if (!opts?.newTab && currentBox && isCardInBox(id, currentBox, allCards)) {
          focusId = id;
          boxId = currentBox;
        } else {
          // 严格按 Folgezettel：5 是自己的 box；5a 的 box 是 5；1a2b 的 box 是 1
          // 不再因为某个 INDEX 引用了它就把它塞进那个 INDEX 的 box
          boxId = findFolgezettelRoot(id, allCards);
          focusId = id;
        }
      }

      openTab(
        { kind: 'card', title, cardBoxId: boxId, cardFocusId: focusId },
        opts,
      );
    },
    [openTab, cardsQ.data],
  );
}
