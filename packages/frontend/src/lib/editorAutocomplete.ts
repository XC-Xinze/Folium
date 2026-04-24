/**
 * 编辑器 autocomplete：扫描 textarea 光标前的文本，识别触发器。
 *
 * 三种触发器：
 *   - `[[query`   → wikilink, 候选 = 卡片
 *   - `![[query`  → transclusion, 候选 = 卡片
 *   - `#query`    → tag, 候选 = 已有 tag
 *
 * 触发器只在"未关闭"时才有效（即 [[ 后面还没出现 ]）
 */

export type TriggerKind = 'wikilink' | 'transclusion' | 'tag';

export interface Trigger {
  kind: TriggerKind;
  /** 触发字符的起始位置（包含 [[ / ![[ / # 本身） */
  triggerStart: number;
  /** query 的起始位置（在 [[ / ![[ / # 之后） */
  queryStart: number;
  /** 当前已输入的 query 文本 */
  query: string;
}

const WINDOW = 64;

export function detectTrigger(text: string, caret: number): Trigger | null {
  // 只看光标前 WINDOW 个字符 —— query 不可能超过这个长度
  const start = Math.max(0, caret - WINDOW);
  const slice = text.slice(start, caret);

  // transclusion: ![[query  （query 不含 [ ] \n）
  const mT = /!\[\[([^[\]\n]*)$/.exec(slice);
  if (mT) {
    const q = mT[1]!;
    const triggerStart = caret - mT[0].length;
    return { kind: 'transclusion', triggerStart, queryStart: triggerStart + 3, query: q };
  }

  // wikilink: [[query —— 用负 lookbehind 排除 ![[
  const mW = /(?<!!)\[\[([^[\]\n]*)$/.exec(slice);
  if (mW) {
    const q = mW[1]!;
    const triggerStart = caret - mW[0].length;
    return { kind: 'wikilink', triggerStart, queryStart: triggerStart + 2, query: q };
  }

  // tag: #query （# 前是开头/空白/markdown 边界；query 是单 word，含 CJK & 连字符）
  const mTag = /(?:^|[\s>([{,;:.!?，。；：！？、\-])#([\w一-龥]*)$/.exec(slice);
  if (mTag) {
    const q = mTag[1]!;
    const triggerStart = caret - q.length - 1;
    return { kind: 'tag', triggerStart, queryStart: triggerStart + 1, query: q };
  }

  return null;
}

/**
 * 用 replacement 替换 trigger 整段 + query。caret 落到 replacement 末尾。
 */
export function applyTrigger(
  text: string,
  trigger: Trigger,
  replacement: string,
  caret: number,
): { text: string; caret: number } {
  const before = text.slice(0, trigger.triggerStart);
  const after = text.slice(caret);
  const next = before + replacement + after;
  return { text: next, caret: before.length + replacement.length };
}

export function formatInsertion(kind: TriggerKind, value: string): string {
  switch (kind) {
    case 'wikilink':
      return `[[${value}]]`;
    case 'transclusion':
      return `![[${value}]]`;
    case 'tag':
      return `#${value} `;
  }
}
