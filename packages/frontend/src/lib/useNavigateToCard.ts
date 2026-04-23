import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CardSummary } from './api';
import { useUIStore } from '../store/uiStore';

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

/** 找一张卡的"主盒子"——优先直接被引用的 INDEX，其次沿 Folgezettel 父链上找 */
function findPrimaryBox(cardId: string, allCards: CardSummary[]): string | null {
  const indexes = allCards.filter((c) => c.status === 'INDEX');
  const directlyReferencing = indexes.find((idx) => idx.crossLinks.includes(cardId));
  if (directlyReferencing) return directlyReferencing.luhmannId;
  // 沿 Folgezettel 父链向上找
  let current = cardId;
  while (true) {
    const parent = deriveParentId(current);
    if (!parent) break;
    if (!allCards.find((c) => c.luhmannId === parent)) break;
    const idx = indexes.find((i) => i.crossLinks.includes(parent));
    if (idx) return idx.luhmannId;
    current = parent;
  }
  return null;
}

/** 判断一张卡是否在某个 box 的可视范围内（box 引用的卡片 + 它们的 Folgezettel 子树） */
function isCardInBox(cardId: string, boxId: string, allCards: CardSummary[]): boolean {
  if (cardId === boxId) return true;
  const box = allCards.find((c) => c.luhmannId === boxId);
  if (!box || box.status !== 'INDEX') return false;
  const directRefs = new Set<string>(box.crossLinks);
  if (directRefs.has(cardId)) return true;
  // 检查是不是某个 directRef 的 Folgezettel 后代（不严格，简单前缀）
  let current = cardId;
  while (true) {
    const parent = deriveParentId(current);
    if (!parent) break;
    if (directRefs.has(parent)) return true;
    current = parent;
  }
  return false;
}

/**
 * 统一的卡片导航：
 *   - 点 INDEX 卡 → 切换 box 和 focus
 *   - 点 ATOMIC 卡且在当前 box 内 → 只改 focus
 *   - 点 ATOMIC 卡但不在当前 box → 切到该卡的 primary box，并 focus
 */
export function useNavigateToCard() {
  const setFocus = useUIStore((s) => s.setFocus);
  const setBoxAndFocus = useUIStore((s) => s.setBoxAndFocus);
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });

  return useCallback(
    (id: string) => {
      const allCards = cardsQ.data?.cards ?? [];
      const card = allCards.find((c) => c.luhmannId === id);
      if (!card) {
        setFocus(id);
        return;
      }
      if (card.status === 'INDEX') {
        setBoxAndFocus(id);
        return;
      }
      // ATOMIC：判断是否在当前 box
      const currentBox = useUIStore.getState().focusedBoxId;
      if (currentBox && isCardInBox(id, currentBox, allCards)) {
        setFocus(id);
        return;
      }
      // 不在当前 box → 找 primary box
      const primary = findPrimaryBox(id, allCards);
      if (primary) {
        setBoxAndFocus(primary, id);
      } else {
        setFocus(id);
      }
    },
    [setFocus, setBoxAndFocus, cardsQ.data],
  );
}
