import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../db/schema.js';
import { CardRepository } from './repository.js';
import { scanVault } from './scanner.js';

function repo() {
  const db = new Database(':memory:');
  initSchema(db);
  return { db, repo: new CardRepository(db) };
}

describe('scanVault', () => {
  it('resolves body wikilinks by title after all cards are scanned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zk-scan-'));
    await writeFile(
      join(dir, '1.md'),
      `---\nluhmannId: 1\ntitle: Source\n---\n\nSee [[Active Learning]].\n`,
    );
    await writeFile(
      join(dir, '2.md'),
      `---\nluhmannId: 2\ntitle: Active Learning\n---\n\nTarget.\n`,
    );

    const { db, repo: cardRepo } = repo();
    await scanVault(dir, cardRepo);

    const rows = db
      .prepare(`SELECT source_id, target_id FROM cross_links`)
      .all() as Array<{ source_id: string; target_id: string }>;
    expect(rows).toEqual([{ source_id: '1', target_id: '2' }]);
  });

  it('fails loudly on duplicate luhmannId values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zk-scan-'));
    await writeFile(join(dir, 'a.md'), `---\nluhmannId: 1\ntitle: A\n---\n`);
    await writeFile(join(dir, 'b.md'), `---\nluhmannId: 1\ntitle: B\n---\n`);

    const { repo: cardRepo } = repo();
    await expect(scanVault(dir, cardRepo)).rejects.toThrow('Duplicate luhmannId');
  });

  it('treats top-level cards as indexes even without children', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zk-scan-'));
    await writeFile(join(dir, '4.md'), `---\nluhmannId: 4\ntitle: Inbox\n---\n\nNo children yet.\n`);

    const { repo: cardRepo } = repo();
    await scanVault(dir, cardRepo);

    expect(cardRepo.getById('4')?.status).toBe('INDEX');
  });
});
