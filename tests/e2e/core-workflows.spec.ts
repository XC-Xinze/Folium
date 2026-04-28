import { expect, test, type Page } from '@playwright/test';

async function waitForCards(page: Page) {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(page.getByText('Folgezettel 编号系统').first()).toBeVisible();
}

test('loads cards and can toggle star from a card node', async ({ page, request }) => {
  await waitForCards(page);

  const starButton = page.locator('button[title^="Star "]').first();
  await expect(starButton).toBeAttached();
  const title = await starButton.getAttribute('title');
  const id = title!.replace(/^Star /, '');
  await request.delete(`/api/starred/${encodeURIComponent(id)}`);
  await page.reload();
  await waitForCards(page);

  await page.locator(`button[title="Star ${id}"]`).evaluate((el) => (el as HTMLElement).click());
  await expect
    .poll(async () => {
      const res = await request.get('/api/starred');
      return ((await res.json()).ids as string[]) ?? [];
    })
    .toContain(id);

  await page.locator(`button[title="Unstar ${id}"]`).evaluate((el) => (el as HTMLElement).click());
  await expect
    .poll(async () => {
      const res = await request.get('/api/starred');
      return ((await res.json()).ids as string[]) ?? [];
    })
    .not.toContain(id);
});

test('card wheel scrolling does not zoom the canvas viewport', async ({ page }) => {
  await waitForCards(page);

  const viewport = page.locator('.react-flow__viewport');
  const content = page.locator('.prose-card').first();
  await expect(content).toBeVisible();

  const before = await viewport.evaluate((el) => getComputedStyle(el).transform);
  const box = await content.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(box!.height / 2, 80));
  await page.mouse.wheel(0, 400);
  const after = await viewport.evaluate((el) => getComputedStyle(el).transform);

  expect(after).toBe(before);
});

test('top-level cards are exposed as index cards', async ({ request }) => {
  const res = await request.get('/api/cards');
  expect(res.ok()).toBe(true);
  const body = await res.json();
  const top = body.cards
    .filter((c: { luhmannId: string }) => ['1', '2', '3', '4'].includes(c.luhmannId))
    .map((c: { luhmannId: string; status: string }) => [c.luhmannId, c.status]);

  expect(Object.fromEntries(top)).toEqual({
    '1': 'INDEX',
    '2': 'INDEX',
    '3': 'INDEX',
    '4': 'INDEX',
  });
});

test('can send the visible graph into a superlink workspace', async ({ page, request }) => {
  await waitForCards(page);

  const beforeRes = await request.get('/api/workspaces');
  expect(beforeRes.ok()).toBe(true);
  const beforeIds = new Set(((await beforeRes.json()).workspaces as Array<{ id: string }>).map((ws) => ws.id));
  let createdId: string | null = null;

  try {
    await page.getByTitle('Pick cards on the canvas and copy them into a new workspace').click();
    await expect(page.getByText(/1 cards ·/)).toBeVisible();
    await page.getByRole('button', { name: 'Create Workspace' }).click();
    await expect(page.getByText('Create picked chain')).toBeVisible();
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(/^Superlink ·/).first()).toBeVisible();

    await expect
      .poll(async () => {
        const res = await request.get('/api/workspaces');
        const body = await res.json();
        const created = (body.workspaces as Array<{ id: string; name: string; nodes: unknown[] }>).find(
          (ws) => !beforeIds.has(ws.id) && ws.name.startsWith('Superlink ·'),
        );
        createdId = created?.id ?? createdId;
        return created?.nodes.length ?? 0;
      })
      .toBeGreaterThan(0);
  } finally {
    if (createdId) {
      await request.delete(`/api/workspaces/${createdId}`);
    }
  }
});
