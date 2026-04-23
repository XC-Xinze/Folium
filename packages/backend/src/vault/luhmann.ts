/**
 * 卢曼编号工具：解析 "1a2b" 这种数字-字母交替编号。
 *
 * 规则：
 *   - 顶层为数字段
 *   - 之后数字段与字母段交替：1a, 1a2, 1a2b, 1a2b3, ...
 *   - 段之间允许用 "/" 显式分隔（兼容真实档案如 "21/3d7a6"），无分隔时按数字↔字母切换分段
 */

export type Segment =
  | { kind: 'num'; value: number }
  | { kind: 'alpha'; value: string };

const SEG_RE = /\d+|[a-zA-Z]+/g;

export function parseSegments(luhmannId: string): Segment[] {
  const cleaned = luhmannId.trim();
  if (!cleaned) return [];
  const matches = cleaned.match(SEG_RE) ?? [];
  return matches.map((m) =>
    /^\d+$/.test(m)
      ? { kind: 'num', value: Number(m) }
      : { kind: 'alpha', value: m.toLowerCase() },
  );
}

export function depth(luhmannId: string): number {
  return parseSegments(luhmannId).length;
}

export function parentId(luhmannId: string): string | null {
  const segs = parseSegments(luhmannId);
  if (segs.length <= 1) return null;
  return segmentsToCanonical(segs.slice(0, -1));
}

/**
 * 生成可按字典序正确排序的键。
 * 数字段 zero-pad 到 6 位，字母段保持。段间用 "|" 分隔，避免 "1a10" 排在 "1a2" 前的字符串排序错误。
 */
export function sortKey(luhmannId: string): string {
  return parseSegments(luhmannId)
    .map((seg) =>
      seg.kind === 'num'
        ? `n${String(seg.value).padStart(6, '0')}`
        : `a${seg.value}`,
    )
    .join('|');
}

/**
 * 段序列还原为规范字符串：1a2b 形式（无分隔符）。
 */
export function segmentsToCanonical(segs: Segment[]): string {
  return segs.map((s) => (s.kind === 'num' ? String(s.value) : s.value)).join('');
}

/**
 * 推导一个 luhmannId 的父级。
 *   1a2 → 1a
 *   1a → 1
 *   1 → null
 */
export function deriveParentIdFn(luhmannId: string): string | null {
  const segs = parseSegments(luhmannId);
  if (segs.length <= 1) return null;
  return segmentsToCanonical(segs.slice(0, -1));
}

/**
 * 规范化用户输入的编号：去掉空白和分隔符，统一小写。
 */
export function canonicalize(luhmannId: string): string {
  return segmentsToCanonical(parseSegments(luhmannId));
}
