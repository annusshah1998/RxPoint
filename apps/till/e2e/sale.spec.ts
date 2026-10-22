import { expect, test, type Page } from '@playwright/test';
import { createAugmentin, setUpTill } from './helpers';

async function stockAndShift(page: Page) {
  await createAugmentin(page);
  await page.getByLabel('Batch no.').fill('AU1123');
  await page.getByLabel('Expiry').fill('03/2027');
  await page.getByLabel('Quantity').fill('2b');
  await page.getByRole('button', { name: 'Add stock' }).click();
  await expect(page.getByText('Stock added')).toBeVisible();

  await page.getByRole('link', { name: 'Shift' }).click();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1' })).toBeVisible();
  await page.getByRole('link', { name: 'Sale', exact: true }).click();
}

test('scan, pay cash and see the receipt; then void it', async ({ page }) => {
  const problems = await setUpTill(page);
  await stockAndShift(page);

  // A barcode typed by hand plus Enter is a scan: one Box (18 tablets) at Rs 436.20 a strip.
  const scan = page.getByLabel('Scan or search');
  await scan.fill('8961234567890');
  await scan.press('Enter');
  await expect(page.getByRole('row', { name: /Augmentin 625mg/ })).toContainText('1 Box');
  // "2s*augm": two more strips, typed the quick way.
  await scan.fill('2s*augm');
  await scan.press('Enter');
  await expect(page.getByRole('row', { name: /Augmentin 625mg/ })).toContainText('1 Box, 2 Strips');
  // 30 tablets = Rs 2,181.00 (rounded once per line).
  await expect(page.getByTestId('sale-total')).toContainText('Rs 2,181.00');

  // + and − change the selected line by one of its unit (a Box), never below one.
  await scan.press('-');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 1,309.00');
  await scan.press('-');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 1,309.00');

  // Pay: F9, Rs 2,000 cash.
  await page.keyboard.press('F9');
  await expect(page.getByTestId('pay-total')).toHaveText('Rs 1,309.00');
  await page.getByLabel('Cash received').fill('2000');
  await expect(page.getByTestId('pay-balance')).toContainText('Rs 691.00');
  await page.getByRole('button', { name: 'Complete sale' }).click();

  await expect(page.getByTestId('change-due')).toHaveText('Rs 691.00');
  await expect(page.getByText('Invoice T1-000001', { exact: true })).toBeVisible();
  const receipt = page.getByTestId('receipt-preview');
  await expect(receipt).toContainText('T1-000001');
  await expect(receipt).toContainText('T O T A L');
  await expect(receipt).toContainText('Batch AU1123 Exp Mar 2027');
  const text = await receipt.innerText();
  expect(text.split('\n').every((l) => l.length <= 48)).toBe(true);

  // Enter starts the next sale.
  await page.keyboard.press('Enter');
  await expect(page.getByText('Scan an item or type its name to start.')).toBeVisible();

  // The sale is listed; void it.
  await page.getByRole('link', { name: 'Sales', exact: true }).click();
  await page.getByRole('button', { name: 'T1-000001' }).click();
  await page.getByRole('button', { name: 'Void sale' }).click();
  await page.getByLabel('Reason').fill('Rang up by mistake');
  await page.getByRole('dialog').getByRole('button', { name: 'Void sale' }).click();
  await expect(page.getByText('Give back Rs 1,309.00 cash')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).last().click();
  await expect(page.getByRole('row', { name: /T1-000001/ })).toContainText('Voided');

  expect(problems).toEqual([]);
});

test('a reload keeps the sale in progress; hold and resume', async ({ page }) => {
  const problems = await setUpTill(page);
  await stockAndShift(page);
  const scan = page.getByLabel('Scan or search');
  await scan.fill('8961234567890');
  await scan.press('Enter');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 1,309.00');

  // Power cut / reload: log in again and the cart is still there.
  await page.waitForTimeout(400);
  await page.reload();
  await page.getByLabel('PIN for Annus').fill('246810');
  await page.getByLabel('PIN for Annus').press('Enter');
  await expect(page.getByText('The sale in progress was restored.')).toBeVisible();
  await expect(page.getByTestId('sale-total')).toContainText('Rs 1,309.00');

  // Hold it, ring up something else, then bring it back.
  await page.keyboard.press('F8');
  await page.getByLabel('Note (optional)').fill('Lady in blue');
  await page.getByRole('dialog').getByRole('button', { name: 'Hold' }).click();
  await expect(page.getByText('Scan an item or type its name to start.')).toBeVisible();
  await page.keyboard.press('Shift+F8');
  await expect(page.getByText('Lady in blue')).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByTestId('sale-total')).toContainText('Rs 1,309.00');

  expect(problems).toEqual([]);
});
