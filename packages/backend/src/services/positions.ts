import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

/**
 * 用户拖拽的卡片位置存储。
 *   存储位置：<vault>/.zettel/positions.json
 *   格式：    { "1a": { x: 320, y: -180 }, ... }
 *   - 跨会话持久（写入磁盘）
 *   - 全局唯一（同一卡片在任意 focus 视图下都用这个位置）
 */

export interface Position {
  x: number;
  y: number;
}
export type PositionMap = Record<string, Position>;

const ZETTEL_DIR = '.zettel';
const POSITIONS_FILE = 'positions.json';

const dirPath = () => join(config.vaultPath, ZETTEL_DIR);
const filePath = () => join(dirPath(), POSITIONS_FILE);

let cache: PositionMap | null = null;

export async function loadPositions(): Promise<PositionMap> {
  if (cache) return cache;
  try {
    const raw = await readFile(filePath(), 'utf8');
    cache = JSON.parse(raw) as PositionMap;
    return cache;
  } catch {
    cache = {};
    return cache;
  }
}

async function flush(map: PositionMap): Promise<void> {
  await mkdir(dirPath(), { recursive: true });
  await writeFile(filePath(), JSON.stringify(map, null, 2), 'utf8');
  cache = map;
}

export async function setPosition(id: string, x: number, y: number): Promise<void> {
  const map = await loadPositions();
  map[id] = { x, y };
  await flush(map);
}

export async function deletePosition(id: string): Promise<void> {
  const map = await loadPositions();
  delete map[id];
  await flush(map);
}

export async function clearPositions(): Promise<void> {
  await flush({});
}
