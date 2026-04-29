import type { CardSummary } from './api';

export const MAX_EXPLORATION_DEPTH = 3;

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

export function cardsAreStructurallyLinked(cards: CardSummary[], a: string, b: string): boolean {
  if (a === b) return true;
  const cardA = cards.find((c) => c.luhmannId === a);
  const cardB = cards.find((c) => c.luhmannId === b);
  if (!cardA || !cardB) return false;
  if (deriveParentId(cardA.luhmannId) === b || deriveParentId(cardB.luhmannId) === a) return true;
  return cardA.crossLinks.includes(b) || cardB.crossLinks.includes(a);
}

export function appendExplorationTrail(
  prev: string[],
  focusedBoxId: string,
  id: string,
  maxDepth = MAX_EXPLORATION_DEPTH,
): string[] {
  const withoutCurrent = prev.filter((existing) => existing !== id && existing !== focusedBoxId);
  const next = id === focusedBoxId ? withoutCurrent : [...withoutCurrent, id];
  return [focusedBoxId, ...next.slice(-maxDepth)];
}

export function nextExplorationTrail(input: {
  prevTrail: string[];
  focusedBoxId: string;
  previousFocusId: string;
  nextFocusId: string;
  focusDepth: number;
  cards: CardSummary[];
  maxDepth?: number;
}): string[] {
  const { prevTrail, focusedBoxId, previousFocusId, nextFocusId, focusDepth, cards } = input;
  const maxDepth = input.maxDepth ?? MAX_EXPLORATION_DEPTH;
  const focusCard = cards.find((c) => c.luhmannId === nextFocusId);
  if (!focusCard) return [focusedBoxId];
  if (focusDepth > 0) {
    return appendExplorationTrail(prevTrail, focusedBoxId, nextFocusId, maxDepth);
  }
  const continuingPath =
    prevTrail.includes(previousFocusId) && cardsAreStructurallyLinked(cards, previousFocusId, nextFocusId);
  if (continuingPath) {
    return appendExplorationTrail(prevTrail, focusedBoxId, nextFocusId, maxDepth);
  }
  return nextFocusId === focusedBoxId ? [focusedBoxId] : [focusedBoxId, nextFocusId];
}
