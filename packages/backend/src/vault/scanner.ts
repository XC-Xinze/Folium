import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CardRepository } from './repository.js';
import { parseCardFile } from './parser.js';
import { hooks } from '../hooks.js';

export async function* walkMd(root: string): AsyncIterable<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      yield* walkMd(full);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      yield full;
    }
  }
}

export async function scanVault(vaultPath: string, repo: CardRepository): Promise<number> {
  const start = Date.now();
  let count = 0;
  const seenPaths = new Set<string>();
  for await (const file of walkMd(vaultPath)) {
    seenPaths.add(file);
    const card = await parseCardFile(file);
    if (card) {
      repo.upsertOne(card);
      hooks.emit('card:parsed', card);
      count += 1;
    }
  }
  // 清理孤儿：DB 里有但磁盘上已不存在的卡片
  const removed = repo.removeOrphans(seenPaths);
  if (removed > 0) {
    console.log(`[scanner] removed ${removed} orphan card(s) from index`);
  }
  const durationMs = Date.now() - start;
  hooks.emit('vault:scanned', { count, durationMs });
  return count;
}
