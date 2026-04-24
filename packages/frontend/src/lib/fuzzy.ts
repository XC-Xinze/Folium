/**
 * 简易的"快速跳转"打分：先尝试 substring（前缀分高），再退化到 subsequence。
 * 不是 fzf 那么强但够 200 卡的场景用。返回 0 表示不匹配。
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  if (!target) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // 1) 完全相等：满分
  if (t === q) return 1000;
  // 2) 前缀匹配：很高
  if (t.startsWith(q)) return 800 - (t.length - q.length);
  // 3) 子串匹配：按位置 + 长度差衰减
  const pos = t.indexOf(q);
  if (pos >= 0) return 600 - pos - (t.length - q.length);
  // 4) 子序列匹配：每个 query 字符按顺序出现在 target 里
  let ti = 0;
  let lastMatch = -1;
  let gapPenalty = 0;
  for (const qc of q) {
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === qc) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found < 0) return 0;
    if (lastMatch >= 0) gapPenalty += found - lastMatch - 1;
    lastMatch = found;
    ti++;
  }
  return 200 - gapPenalty;
}
