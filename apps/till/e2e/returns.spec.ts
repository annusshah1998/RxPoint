import { expect, test, type Page } from '@playwright/test';
import { addStaff, createAugmentin, setUpTill, switchUser } from './helpers';

/** Two boxes of Augmentin on the shelf, a cashier and a pharmacist, an open shift. */
async function storeWithStaff(page: Page) {
  await createAugmentin(page);
  await page.getByLabel('Batch no.').fill('AU1123');
  await page.getByLabel('Expiry').fill('03/2027');
  await page.getByLabel('Quantity').fill('2b');
  await page.getByRole('button', { name: 'Add stock' }).click();
  await expect(page.getByText('Stock added')).toBeVisible();

  await addStaff(page, 'Bilal', 'Cashier', '1470');
  await addStaff(page, 'Sana', 'Pharmacist', '2580');

  await page.getByRole('link', { name: 'Shift' }).click();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1' })).toBeVisible();
}

/** Sells one Box (18 tablets, Rs 1,309.00) for exact cash. */
async function sellOneBox(page: Page) {
  await page.getByRole('link', { name: 'Sale', exact: true }).click();
  const scan = page.getByLabel('Scan or search');
  await scan.fill('8961234567890');
  await scan.press('Enter');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 1,309.00');
  await page.keyboard.press('F9');
  await page.getByLabel('Cash received').fill('1309');
  await page.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByText('Invoice T1-000001', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
}

async function openReturn(page: Page) {
  await page.getByRole('link', { name: 'Sales', exact: true }).click();
  await page.getByRole('button', { name: 'T1-000001' }).click();
  await page.getByRole('button', { name: 'Return items' }).click();
  await expect(page.getByRole('heading', { name: 'Return items from T1-000001' })).toBeVisible();
}

test('return a strip for cash, then the rest with a pharmacist’s PIN', async ({ page }) => {
  const problems = await setUpTill(page);
  await storeWithStaff(page);
  await sellOneBox(page);

  // The owner takes one strip back. Asking for more than was sold is caught on the row.
  await openReturn(page);
  const augmentin = page.getByLabel(/^Return now: Augmentin/);
  await augmentin.fill('2b');
  await expect(page.getByText('Only 1 Box left to return')).toBeVisible();
  await augmentin.fill('1s');
  await page
    .getByLabel('Why is it coming back?')
    .selectOption({ label: 'Doctor changed the medicine' });
  // 6 of 18 tablets: Rs 436.20, rounded to Rs 436.00, paid back in cash as the sale was.
  await expect(page.getByTestId('return-total')).toHaveText('Rs 436.00');
  await expect(page.getByText('Rounding')).toBeVisible();
  await expect(page.getByLabel('Cash', { exact: true })).toHaveValue('436.00');
  await expect(page.getByRole('row', { name: /Augmentin/ }).getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: 'Return and refund Rs 436.00' }).click();

  await expect(page.getByText('Return T1-R000001 recorded')).toBeVisible();
  await expect(page.getByText('Give back Rs 436.00 cash')).toBeVisible();
  const receipt = page.getByTestId('receipt-preview');
  await expect(receipt).toContainText('*** RETURN ***');
  await expect(receipt).toContainText('Return T1-R000001');
  await expect(receipt).toContainText('For invoice T1-000001');
  await expect(receipt).toContainText('Reason: Doctor changed the medicine');
  const text = await receipt.innerText();
  expect(text.split('\n').every((l) => l.length <= 48)).toBe(true);
  await page.getByRole('button', { name: 'Close' }).last().click();
  await expect(page.getByRole('row', { name: /T1-000001/ })).toContainText('Returned');

  // The strip is back on the shelf: 2 Boxes − 1 sold + 1 Strip back.
  await page.getByRole('link', { name: 'Products' }).click();
  await expect(page.getByRole('row', { name: /Augmentin 625mg/ })).toContainText('1 Box, 1 Strip');

  // A cashier returns the other two strips; returns need a pharmacist or the owner.
  await switchUser(page, 'Bilal', '1470');
  await openReturn(page);
  await expect(page.getByRole('row', { name: /Augmentin/ })).toContainText('1 Strip');
  await page.getByLabel(/^Return now: Augmentin/).fill('2s');
  await page.getByLabel('Why is it coming back?').selectOption({ label: 'Damaged' });
  // The last return pays back exactly what is left: Rs 1,309.00 − Rs 436.00.
  await expect(page.getByTestId('return-total')).toHaveText('Rs 873.00');
  await expect(page.getByText('This needs a PIN from a pharmacist or the owner.')).toBeVisible();
  await page.getByLabel('Approved by').selectOption({ label: 'Sana' });
  await page.getByLabel('Their PIN').fill('0000');
  await page.getByRole('button', { name: 'Return and refund Rs 873.00' }).click();
  await expect(page.getByText(/Wrong PIN/)).toBeVisible();
  await page.getByLabel('Their PIN').fill('2580');
  await page.getByLabel('Their PIN').press('Enter');

  await expect(page.getByText('Return T1-R000002 recorded')).toBeVisible();
  await expect(page.getByText('Give back Rs 873.00 cash')).toBeVisible();
  await expect(page.getByTestId('receipt-preview')).toContainText('Approved by Sana');
  await page.getByRole('button', { name: 'Close' }).last().click();

  // Everything is back: no more returns, and both are listed on the sale.
  await page.getByRole('button', { name: 'T1-000001' }).click();
  await expect(page.getByRole('button', { name: 'Return items' })).toHaveCount(0);
  await expect(page.getByText('T1-R000001: Rs 436.00 back (Annus)')).toBeVisible();
  await expect(page.getByText('T1-R000002: Rs 873.00 back (Bilal)')).toBeVisible();

  expect(problems).toEqual([]);
});
