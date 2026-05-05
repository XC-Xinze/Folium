export const manifest = {
  id: 'folium.mermaid-renderer',
  name: 'Mermaid Renderer',
  version: '0.1.0',
  minAppVersion: '1.5.0',
  mobile: true,
};

const CDN_URL = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';

function ensureStyle() {
  if (document.getElementById('folium-mermaid-renderer-style')) return;
  const style = document.createElement('style');
  style.id = 'folium-mermaid-renderer-style';
  style.textContent = `
    .folium-mermaid {
      overflow-x: auto;
      margin: 12px 0;
      padding: 14px;
      border: 1px solid var(--border-muted, rgba(116, 120, 120, 0.28));
      border-radius: 10px;
      background: var(--surface-panel, rgba(255, 255, 255, 0.72));
    }
    .folium-mermaid svg {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }
    .folium-mermaid-error {
      white-space: pre-wrap;
      color: #ba1a1a;
      border-color: rgba(186, 26, 26, 0.35);
      background: rgba(255, 218, 214, 0.34);
    }
  `;
  document.head.appendChild(style);
}

async function loadMermaid() {
  if (!window.__foliumMermaidPromise) {
    window.__foliumMermaidPromise = import(/* @vite-ignore */ CDN_URL).then((mod) => mod.default ?? mod);
  }
  const mermaid = await window.__foliumMermaidPromise;
  const dark = document.documentElement.classList.contains('dark');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
  });
  return mermaid;
}

function findMermaidBlocks(root) {
  return [...root.querySelectorAll('pre > code.language-mermaid, pre > code[class*="language-mermaid"]')]
    .map((code) => ({ code, pre: code.closest('pre') }))
    .filter((item) => item.pre && item.pre.dataset.mermaidProcessed !== '1');
}

export default function activate(ctx) {
  ensureStyle();
  const unregister = ctx.sdk.markdown.registerPostprocessor({
    id: 'folium.mermaid-renderer.render',
    async process(root) {
      const blocks = findMermaidBlocks(root);
      if (blocks.length === 0) return;
      const mermaid = await loadMermaid();

      for (const { code, pre } of blocks) {
        const source = code.textContent?.trim() ?? '';
        if (!source) continue;
        pre.dataset.mermaidProcessed = '1';
        const container = document.createElement('div');
        container.className = 'folium-mermaid';
        pre.replaceWith(container);

        try {
          const id = `folium-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
          const result = await mermaid.render(id, source);
          container.innerHTML = result.svg;
        } catch (err) {
          container.classList.add('folium-mermaid-error');
          container.textContent = `Mermaid render failed:\n${err?.message ?? String(err)}`;
          ctx.log.warn('Mermaid render failed', err);
        }
      }
    },
  });

  return {
    deactivate() {
      unregister();
    },
  };
}
