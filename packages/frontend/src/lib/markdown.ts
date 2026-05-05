import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { VAULT_BASE } from './backendUrl';
import { PluginRegistry } from './pluginRegistry';

const purifier = typeof window !== 'undefined' ? createDOMPurify(window) : null;

// 把附件相对路径（attachments/x.png）重写为后端服务的绝对 URL（/vault/attachments/x.png）
function rewriteAttachmentUrl(url: string): string {
  if (!url) return url;
  if (/^(https?:|data:|\/)/.test(url)) return url;
  // 其它相对路径，假定是 vault 内的资源
  return `${VAULT_BASE}/${url.replace(/^\.?\/?/, '')}`;
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
 * 将 Markdown 渲染为 HTML：
 *   1. ![[id]] → 嵌入占位 div（待 attachTransclusion 异步填充内容）
 *   2. [[link]] → 可点击 span
 */
export function renderMarkdown(md: string, onLink?: (target: string) => void): string {
  // 嵌入语法 ![[id]] 必须先于 [[link]] 处理
  let processed = md.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string) => {
    if (target.trim().startsWith('res_')) {
      const safe = escapeAttr(target.trim());
      return `<div class="resource-embed" data-resource="${safe}">Loading [[${safe}]]…</div>`;
    }
    const safe = escapeAttr(target.trim());
    return `<div class="transclude" data-transclude="${safe}"><div class="transclude-loading">Loading [[${safe}]]…</div></div>`;
  });
  processed = processed.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => {
    const display = escapeHtml((alias ?? target).trim());
    const safe = escapeAttr(target.trim());
    if (target.trim().startsWith('res_')) {
      return `<span class="resource-link" data-resource-link="${safe}">${display}</span>`;
    }
    return `<span class="wikilink" data-link="${safe}">${display}</span>`;
  });
  const html = marked.parse(processed, { async: false, renderer }) as string;
  void onLink;
  return sanitizeHtml(html);
}

export function attachResourceHandler(
  root: HTMLElement,
  getResource: (id: string) => Promise<{
    id: string;
    kind: 'image' | 'pdf' | 'audio' | 'video' | 'file';
    title: string;
    path: string;
    tags: string[];
  } | null>,
  openResource: (relativePath: string) => void | Promise<void>,
): () => void {
  let cancelled = false;
  const render = async () => {
    const embeds = root.querySelectorAll<HTMLElement>('[data-resource]');
    for (const el of embeds) {
      const id = el.dataset.resource;
      if (!id || el.dataset.resourceLoaded === '1') continue;
      el.dataset.resourceLoaded = '1';
      const resource = await getResource(id).catch(() => null);
      if (cancelled) return;
      if (!resource) {
        el.innerHTML = `<div class="resource-missing">[[${escapeHtml(id)}]] not found</div>`;
        continue;
      }
      el.innerHTML = resource.kind === 'image'
        ? `
          <figure class="resource-card resource-card-image" data-resource-open="${escapeAttr(resource.path)}">
            <img src="${escapeAttr(rewriteAttachmentUrl(resource.path))}" alt="${escapeAttr(resource.title)}" />
            <figcaption>${escapeHtml(resource.title)}</figcaption>
          </figure>
        `
        : `
          <div class="resource-card" data-resource-open="${escapeAttr(resource.path)}">
            <span class="resource-kind">${escapeHtml(resource.kind)}</span>
            <span class="resource-title">${escapeHtml(resource.title)}</span>
          </div>
        `;
    }
  };
  const onClick = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const linked = target.closest<HTMLElement>('[data-resource-link]');
    const open = target.closest<HTMLElement>('[data-resource-open]');
    const id = linked?.dataset.resourceLink;
    if (id) {
      e.preventDefault();
      void getResource(id).then((resource) => {
        if (resource) return openResource(resource.path);
      });
      return;
    }
    const path = open?.dataset.resourceOpen;
    if (path) {
      e.preventDefault();
      void openResource(path);
    }
  };
  root.addEventListener('click', onClick);
  void render();
  return () => {
    cancelled = true;
    root.removeEventListener('click', onClick);
  };
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

export function attachMarkdownPostprocessors(root: HTMLElement): () => void {
  let cancelled = false;
  const run = async () => {
    for (const processor of PluginRegistry.markdownPostprocessors.list()) {
      if (cancelled) return;
      try {
        await processor.process(root);
      } catch (err) {
        console.warn('markdown postprocessor failed', processor.id, err);
      }
    }
  };
  const rerun = () => void run();
  void run();
  window.addEventListener('folium:plugins-reloaded', rerun);
  return () => {
    cancelled = true;
    window.removeEventListener('folium:plugins-reloaded', rerun);
  };
}

/**
 * 拦截普通 markdown 链接（[label](relativePath)）的点击。
 * 指向 vault 内附件（/vault/...）的非图片链接 → 调系统 open；
 * 其他外链让浏览器照常处理。
 */
export function attachAttachmentClickHandler(
  root: HTMLElement,
  openInSystem: (relativePath: string) => void,
): () => void {
  const vaultUrlPrefix = `${VAULT_BASE}/`;
  const onClick = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const a = target.closest<HTMLAnchorElement>('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    // 仅处理 vault 内的附件链接（renderMarkdown 已重写过 attachments/* → /vault/attachments/*）
    if (!href.startsWith(vaultUrlPrefix)) return;
    // 排除被嵌入的图片（点 <img> 上的话 closest('a') 还可能拿到外层 a，但通常图片不在 a 里）
    e.preventDefault();
    const rel = href.slice(vaultUrlPrefix.length);
    openInSystem(rel);
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}

/**
 * 把 ![[id]] 渲染出来的占位 .transclude div 异步填充实际卡片内容。
 *   - getCard: 拉一张卡（一般直接传 api.getCard）
 *   - 防递归：传入 visited Set 拦截嵌入循环
 *   - 嵌入深度限制 maxDepth，默认 2
 *
 * 返回 cleanup（暂时空，没装监听器；保留 API 以后扩展）。
 */
export async function attachTransclusion(
  root: HTMLElement,
  getCard: (id: string) => Promise<{ luhmannId: string; title: string; contentMd: string } | null>,
  opts: { visited?: Set<string>; maxDepth?: number; depth?: number } = {},
): Promise<() => void> {
  const visited = opts.visited ?? new Set<string>();
  const maxDepth = opts.maxDepth ?? 2;
  const depth = opts.depth ?? 0;

  const placeholders = root.querySelectorAll<HTMLDivElement>('div.transclude[data-transclude]');
  for (const ph of placeholders) {
    const id = ph.dataset.transclude;
    if (!id) continue;
    if (visited.has(id) || depth >= maxDepth) {
      ph.innerHTML = `<div class="transclude-cycle">embed too deep or cyclic: <code>${escapeHtml(id)}</code></div>`;
      continue;
    }
    try {
      const card = await getCard(id);
      if (!card) {
        ph.innerHTML = `<div class="transclude-missing">[[${escapeHtml(id)}]] not found</div>`;
        continue;
      }
      const innerVisited = new Set(visited);
      innerVisited.add(id);
      const html = renderMarkdown(card.contentMd);
      ph.innerHTML = `
        <div class="transclude-card">
          <div class="transclude-header">
            <span class="transclude-id" data-link="${escapeAttr(id)}">[[${escapeHtml(id)}]]</span>
            <span class="transclude-title">${escapeHtml(card.title)}</span>
          </div>
          <div class="transclude-body">${html}</div>
        </div>
      `;
      // 递归处理被嵌入卡片自己的 ![[]]
      const body = ph.querySelector<HTMLElement>('.transclude-body');
      if (body) {
        await attachTransclusion(body, getCard, {
          visited: innerVisited,
          maxDepth,
          depth: depth + 1,
        });
      }
    } catch {
      ph.innerHTML = `<div class="transclude-missing">[[${escapeHtml(id)}]] failed to load</div>`;
    }
  }
  return () => undefined;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeHtml(html: string): string {
  if (!purifier) return html;
  return purifier.sanitize(html, {
    ADD_ATTR: ['data-link', 'data-transclude', 'data-mermaid-processed', 'data-resource', 'data-resource-link'],
    ADD_TAGS: ['span'],
  });
}
