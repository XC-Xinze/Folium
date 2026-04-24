/**
 * 估算字数：拉丁词按空白分，CJK 按字符。
 *   "Hello world" → 2
 *   "你好世界" → 4
 *   "Hello 世界" → 1 + 2 = 3
 *
 * 不打算 100% 精确——只是给用户一个量级感。
 */
export function countWords(text: string): number {
  if (!text) return 0;
  // 剥掉 markdown 标记 / 链接 / 图片，简单的清理
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ') // links/images
    .replace(/\[\[[^\]]*\]\]/g, ' ') // wikilinks
    .replace(/<[^>]+>/g, ' ') // html
    .replace(/[#*_~>`]/g, ' '); // md punctuation
  // CJK 单字（含日韩中）按字计
  const cjk = stripped.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
  // 拉丁词按空白分
  const latin = stripped
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ')
    .split(/\s+/)
    .filter((w) => /[a-zA-Z0-9]/.test(w));
  return (cjk?.length ?? 0) + latin.length;
}

/** 把 ISO 时间或 mtime（毫秒）转成 "5m ago" / "2d ago" / "Apr 23" 这种 */
export function relativeTime(input: string | number | null | undefined): string {
  if (input == null) return '';
  const ms = typeof input === 'number' ? input : Date.parse(input);
  if (!ms || Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.floor(day / 7)}w ago`;
  // 超过一个月，显示绝对日期
  const d = new Date(ms);
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${m[d.getMonth()]} ${d.getDate()}`;
}
