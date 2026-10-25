import { expect, test, type Page } from '@playwright/test';
import { createAugmentin, setUpTill } from './helpers';

async function stockAndShift(page: Page, options: { rx?: boolean } = {}) {
  await createAugmentin(page, options);
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

  // Pay: F9, then Rs 2,000 typed straight into Cash received and Enter.
  await page.keyboard.press('F9');
  await expect(page.getByTestId('pay-total')).toHaveText('Rs 1,309.00');
  await expect(page.getByLabel('Cash received')).toBeFocused();
  await page.keyboard.type('2000');
  await expect(page.getByTestId('pay-balance')).toContainText('Rs 691.00');
  await page.keyboard.press('Enter');

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

  // Hold it (F8, type the note, Enter), ring up something else, then bring it back.
  await page.keyboard.press('F8');
  await expect(page.getByLabel('Note (optional)')).toBeFocused();
  await page.keyboard.type('Lady in blue');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Scan an item or type its name to start.')).toBeVisible();
  await page.keyboard.press('Shift+F8');
  await expect(page.getByText('Lady in blue')).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByTestId('sale-total')).toContainText('Rs 1,309.00');

  expect(problems).toEqual([]);
});

test('dialogs take the keyboard: line discount, batch picker, hold and Pay', async ({ page }) => {
  const problems = await setUpTill(page);
  await stockAndShift(page, { rx: true });
  const scan = page.getByLabel('Scan or search');
  await scan.fill('8961234567890');
  await scan.press('Enter');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 1,309.00');

  // F6: the cursor is in the discount box, so typing and Enter apply it.
  await page.keyboard.press('F6');
  await expect(page.getByLabel('Discount', { exact: true })).toBeFocused();
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  // 5% of Rs 1,308.60.
  await expect(page.getByRole('row', { name: /Augmentin 625mg/ })).toContainText('-65.43');
  await expect(scan).toBeFocused();

  // F4: the first choice has the cursor. Picking it and pressing F8 at once opens Hold with
  // the cursor in its note; Esc goes back to the scan box.
  await page.keyboard.press('F4');
  const automatic = page.getByRole('button', { name: 'Automatic (first to expire)' });
  await expect(automatic).toBeFocused();
  await automatic.click();
  await page.keyboard.press('F8');
  await expect(page.getByLabel('Note (optional)')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(scan).toBeFocused();

  // F9: Cash received has the cursor, and keeps it when answering "Prescription seen?"
  // redraws the Sale screen behind the dialog.
  await page.keyboard.press('F9');
  const cash = page.getByLabel('Cash received');
  await expect(cash).toBeFocused();
  await page.keyboard.press('Alt+Y');
  await expect(page.getByRole('button', { name: 'Seen', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(cash).toBeFocused();
  // Enter with nothing typed: exact cash.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('change-due')).toHaveText('Rs 0.00');

  expect(problems).toEqual([]);
});
