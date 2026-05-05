/**
 * 卡片拖拽数据协议
 *   - sidebar 列表项 / CardNode 拖拽手柄 → 共用此 mime + payload
 *   - WorkspaceSwitcher / WorkspaceView 接收 drop
 */
export const CARD_DRAG_MIME = 'application/x-zettel-card';
export const RESOURCE_DRAG_MIME = 'application/x-folium-resource';

export interface CardDragPayload {
  luhmannId: string;
  title?: string;
  workspaceNodeId?: string;
  workspaceNodeKind?: 'card' | 'temp';
}

export function setCardDragData(e: React.DragEvent, payload: CardDragPayload): void {
  e.dataTransfer.setData(CARD_DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'copy';
}

export function readCardDragData(e: React.DragEvent): CardDragPayload | null {
  const raw = e.dataTransfer.getData(CARD_DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CardDragPayload;
  } catch {
    return null;
  }
}

export function isCardDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(CARD_DRAG_MIME);
}

export interface ResourceDragPayload {
  resourceId: string;
  title?: string;
  workspaceNodeId?: string;
  workspaceNodeKind?: 'resource';
}

export function setResourceDragData(e: React.DragEvent, payload: ResourceDragPayload): void {
  e.dataTransfer.setData(RESOURCE_DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'copy';
}

export function readResourceDragData(e: React.DragEvent): ResourceDragPayload | null {
  const raw = e.dataTransfer.getData(RESOURCE_DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ResourceDragPayload;
  } catch {
    return null;
  }
}

export function isResourceDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(RESOURCE_DRAG_MIME);
}
