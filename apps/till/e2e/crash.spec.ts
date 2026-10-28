import { expect, test, type Page } from '@playwright/test';
import { OWNER_PIN, createAugmentin, createCalpol, logIn, openShift, setUpTill } from './helpers';

/**
 * The draft as saved in the preview's database (the screen saves within 150 ms of a change),
 * read through a second connection as full-day.spec does.
 */
async function savedDraft(page: Page): Promise<{ lines: number; total: number } | null> {
  return page.evaluate(`(async () => {
    const { createBrowserExecutor } = await import('/src/platform/browser-executor.ts');
    const db = await createBrowserExecutor();
    const { rows } = await db.execute(
      "SELECT line_count AS lines, total FROM sale_draft WHERE status = 'active'",
      [],
    );
    return rows[0] ?? null;
  })()`);
}

test('a sale in progress survives a power cut, and F5 never reloads the till', async ({ page }) => {
  const problems = await setUpTill(page);
  await createAugmentin(page);
  await createCalpol(page);
  await openShift(page);

  // Two lines: a box of Augmentin, and 2 strips of Calpol at 5% off.
  const scan = page.getByLabel('Scan or search');
  await scan.fill('8961234567890');
  await scan.press('Enter');
  await scan.fill('2s*calpol');
  await scan.press('Enter');
  await page.keyboard.press('F6');
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  const augmentin = page.getByRole('row', { name: /Augmentin 625mg/ });
  const calpol = page.getByRole('row', { name: /Calpol 5mg/ });
  const total = page.getByTestId('sale-total');
  // Rs 1,308.60 + Rs 240.00 − Rs 12.00 = Rs 1,536.60, rounded once for the bill.
  await expect(total).toContainText('Rs 1,537.00');

  // The power goes once the last change is saved: no unload, nothing flushed on the way out.
  await expect.poll(() => savedDraft(page)).toEqual({ lines: 2, total: 153_700 });
  await page.reload();
  await logIn(page, 'Annus', OWNER_PIN);
  await expect(page.getByText('The sale in progress was restored.')).toBeVisible();
  await expect(augmentin).toContainText('1 Box');
  await expect(calpol).toContainText('2 Strips');
  await expect(calpol).toContainText('-12.00');
  await expect(total).toContainText('Rs 1,537.00');
  await expect(scan).toBeFocused();

  // F5 (the browser's reload) is cancelled before the browser sees it, so the page stays as
  // it is: no login, the same cart, and the next key still works on it.
  await page.evaluate(() => {
    const w = window as unknown as { f5?: boolean; samePage: boolean };
    w.samePage = true;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F5') w.f5 = e.defaultPrevented;
    });
  });
  await page.keyboard.press('F5');
  await scan.press('+');
  await expect(calpol).toContainText('3 Strips');
  const after = await page.evaluate(() => {
    const w = window as unknown as { f5?: boolean; samePage?: boolean };
    return { f5Cancelled: w.f5, samePage: w.samePage };
  });
  expect(after).toEqual({ f5Cancelled: true, samePage: true });
  await expect(augmentin).toContainText('1 Box');
  expect(problems).toEqual([]);
});
