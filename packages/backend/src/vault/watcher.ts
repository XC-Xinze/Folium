import chokidar, { type FSWatcher } from 'chokidar';
import type { CardRepository } from './repository.js';
import { parseCardFile } from './parser.js';

export function watchVault(vaultPath: string, repo: CardRepository): FSWatcher {
  const watcher = chokidar.watch(vaultPath, {
    ignored: (p) => /(^|\/)\..+|\.db(-journal|-wal|-shm)?$/.test(p),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  const onUpsert = async (path: string) => {
    if (!path.toLowerCase().endsWith('.md')) return;
    try {
      const card = await parseCardFile(path);
      if (card) repo.upsertOne(card);
    } catch (err) {
      console.error('[watcher] parse failed', path, err);
    }
  };

  watcher.on('add', onUpsert);
  watcher.on('change', onUpsert);
  watcher.on('unlink', (path) => {
    repo.deleteByPath(path);
  });

  return watcher;
}
