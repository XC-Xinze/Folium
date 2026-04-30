import { getNodesBounds, type Node } from '@xyflow/react';
import { toPng } from 'html-to-image';

interface ExportCanvasImageInput {
  flowRoot: HTMLElement | null;
  nodes: Node[];
  fileName: string;
  margin?: number;
  pixelRatio?: number;
}

function safeFileName(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'folium-canvas';
}

function downloadDataUrl(dataUrl: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName.endsWith('.png') ? fileName : `${fileName}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export async function exportReactFlowCanvasAsPng({
  flowRoot,
  nodes,
  fileName,
  margin = 96,
  pixelRatio = 2,
}: ExportCanvasImageInput): Promise<void> {
  const viewport = flowRoot?.querySelector<HTMLElement>('.react-flow__viewport');
  const visibleNodes = nodes.filter((node) => !node.hidden);
  if (!viewport || visibleNodes.length === 0) {
    throw new Error('No visible canvas content to export.');
  }

  const bounds = getNodesBounds(visibleNodes);
  const width = Math.ceil(bounds.width + margin * 2);
  const height = Math.ceil(bounds.height + margin * 2);
  const backgroundColor = cssVar('--zk-bg', '#f8f6f1');
  const transform = `translate(${margin - bounds.x}px, ${margin - bounds.y}px) scale(1)`;

  document.documentElement.classList.add('folium-exporting');
  try {
    await document.fonts?.ready;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const dataUrl = await toPng(viewport, {
      backgroundColor,
      cacheBust: true,
      pixelRatio,
      width,
      height,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform,
        transformOrigin: 'top left',
      },
    });
    downloadDataUrl(dataUrl, safeFileName(fileName));
  } finally {
    document.documentElement.classList.remove('folium-exporting');
  }
}
