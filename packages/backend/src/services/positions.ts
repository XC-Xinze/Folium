import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

/**
 * 用户拖拽的卡片位置——按 scope 隔离。
 *   存储位置：<vault>/.zettel/positions.json
 *   格式：    { "box:i1": { "1a": {x,y} }, "box:i2": { "1a": {x,y} }, "tag:ml": {...} }
 *
 *   scope 命名约定：
 *     - box:<luhmannId>  在某个盒子（INDEX/ATOMIC 焦点）下的位置
 *     - tag:<tagName>    TagView 下的位置
 */

export interface Position {
  x: number;
  y: number;
  w?: number;
  h?: number;
}
export type PositionMap = Record<string, Position>;
export type ScopedPositions = Record<string, PositionMap>;

const ZETTEL_DIR = '.zettel';
const POSITIONS_FILE = 'positions.json';

const dirPath = () => join(config.vaultPath, ZETTEL_DIR);
const filePath = () => join(dirPath(), POSITIONS_FILE);

let cache: ScopedPositions | null = null;

/** 检测旧版扁平 schema：{cardId: {x,y}} */
function isFlatLegacy(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  for (const k in obj as Record<string, unknown>) {
    const v = (obj as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && 'x' in (v as object) && 'y' in (v as object)) {
      return true;
    }
    return false;
  }
  return false;
}

async function loadAllInternal(): Promise<ScopedPositions> {
  if (cache) return cache;
  try {
    const raw = await readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (isFlatLegacy(parsed)) {
      // 旧扁平数据 → 收到 'legacy' scope 下，新代码不会读，但不丢用户数据
      cache = { legacy: parsed as PositionMap };
    } else {
      cache = (parsed as ScopedPositions) ?? {};
    }
    return cache;
  } catch {
    cache = {};
    return cache;
  }
}

async function flush(map: ScopedPositions): Promise<void> {
  await mkdir(dirPath(), { recursive: true });
  await writeFile(filePath(), JSON.stringify(map, null, 2), 'utf8');
  cache = map;
}

export async function loadScope(scope: string): Promise<PositionMap> {
  const all = await loadAllInternal();
  return all[scope] ?? {};
}

export async function loadAll(): Promise<ScopedPositions> {
  return loadAllInternal();
}

export async function setPosition(
  scope: string,
  id: string,
  x: number,
  y: number,
  w?: number,
  h?: number,
): Promise<void> {
  const all = await loadAllInternal();
  if (!all[scope]) all[scope] = {};
  // 保留之前的 w/h（如果新调用没传）
  const existing = all[scope][id];
  all[scope][id] = {
    x,
    y,
    w: w ?? existing?.w,
    h: h ?? existing?.h,
  };
  await flush(all);
}

export async function setSize(
  scope: string,
  id: string,
  w: number,
  h: number,
): Promise<void> {
  const all = await loadAllInternal();
  if (!all[scope]) all[scope] = {};
  const existing = all[scope][id] ?? { x: 0, y: 0 };
  all[scope][id] = { ...existing, w, h };
  await flush(all);
}

export async function deletePosition(scope: string, id: string): Promise<void> {
  const all = await loadAllInternal();
  if (!all[scope]) return;
  delete all[scope][id];
  await flush(all);
}

export async function clearScope(scope: string): Promise<void> {
  const all = await loadAllInternal();
  delete all[scope];
  await flush(all);
}

/** vault 切换时清 in-memory cache，下次 load 会从新 vault 的 .zettel/ 重读 */
export function resetPositionsCache(): void {
  cache = null;
}

/** 提权时：把所有 scope 中 oldId 的位置改名为 newId */
export async function renameCardInAllScopes(
  oldId: string,
  newId: string,
): Promise<void> {
  const all = await loadAllInternal();
  let changed = false;
  for (const scope of Object.keys(all)) {
    const map = all[scope]!;
    if (map[oldId]) {
      map[newId] = map[oldId]!;
      delete map[oldId];
      changed = true;
    }
  }
  if (changed) await flush(all);
}
