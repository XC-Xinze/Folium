import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

const ZETTEL_DIR = '.zettel';
const FILE = 'starred.json';

const dirPath = () => join(config.vaultPath, ZETTEL_DIR);
const filePath = () => join(dirPath(), FILE);

let cache: Set<string> | null = null;

export async function loadStarred(): Promise<Set<string>> {
  if (cache) return cache;
  try {
    const raw = await readFile(filePath(), 'utf8');
    cache = new Set(JSON.parse(raw) as string[]);
    return cache;
  } catch {
    cache = new Set();
    return cache;
  }
}

async function flush(): Promise<void> {
  if (!cache) return;
  await mkdir(dirPath(), { recursive: true });
  await writeFile(filePath(), JSON.stringify([...cache], null, 2), 'utf8');
}

export async function listStarred(): Promise<string[]> {
  return [...(await loadStarred())];
}

export async function star(id: string): Promise<void> {
  const set = await loadStarred();
  if (set.has(id)) return;
  set.add(id);
  await flush();
}

export async function unstar(id: string): Promise<void> {
  const set = await loadStarred();
  if (!set.delete(id)) return;
  await flush();
}

/** vault 切换时清 cache */
export function resetStarredCache(): void {
  cache = null;
}
