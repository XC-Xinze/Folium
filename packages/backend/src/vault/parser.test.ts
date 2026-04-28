import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseCardFile } from './parser.js';

describe('parseCardFile', () => {
  it('keeps body wikilink titles intact for repository resolution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zk-parse-'));
    const fp = join(dir, '1.md');
    await writeFile(fp, `---\nluhmannId: 1\ntitle: Source\n---\n\n[[Active Learning]] and [[1a]].\n`);

    const card = await parseCardFile(fp);
    expect(card?.crossLinks).toContain('Active Learning');
    expect(card?.crossLinks).toContain('1a');
  });
});
