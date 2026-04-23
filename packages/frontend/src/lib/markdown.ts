import { marked } from 'marked';

// 把附件相对路径（attachments/x.png）重写为后端服务的绝对 URL（/vault/attachments/x.png）
function rewriteAttachmentUrl(url: string): string {
  if (!url) return url;
  if (/^(https?:|data:|\/)/.test(url)) return url;
  // 其它相对路径，假定是 vault 内的资源
  return `/vault/${url.replace(/^\.?\/?/, '')}`;
}

const renderer = new marked.Renderer();
const origImage = renderer.image.bind(renderer);
renderer.image = function (token) {
  return origImage({ ...token, href: rewriteAttachmentUrl(token.href) });
};
const origLink = renderer.link.bind(renderer);
renderer.link = function (token) {
  // 普通 markdown 链接也按附件路径处理（PDF/zip 等）
  return origLink({ ...token, href: rewriteAttachmentUrl(token.href) });
};

/**
 * 将 Markdown 渲染为 HTML，并把 [[wikilink]] 转成可点击的 span。
 */
export function renderMarkdown(md: string, onLink?: (target: string) => void): string {
  // 先把 [[link]] 替换为带 data-attr 的 span，避免被 marked 当作普通文本
  const withLinks = md.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => {
    const display = (alias ?? target).trim();
    const safe = target.trim().replace(/"/g, '&quot;');
    return `<span class="wikilink" data-link="${safe}">${display}</span>`;
  });
  const html = marked.parse(withLinks, { async: false, renderer }) as string;
  void onLink;
  return html;
}

export function attachWikilinkHandler(
  root: HTMLElement,
  handler: (target: string) => void,
): () => void {
  const onClick = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const link = target.closest<HTMLElement>('[data-link]');
    if (link) {
      e.preventDefault();
      handler(link.dataset.link ?? '');
    }
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
