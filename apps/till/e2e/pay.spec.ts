import { expect, test } from '@playwright/test';
import { OWNER_PIN, addStaff, createAugmentin, setUpTill, switchUser } from './helpers';

test('a free item approved by PIN: Enter finishes the zero bill', async ({ page }) => {
  const problems = await setUpTill(page);
  await createAugmentin(page);
  await page.getByLabel('Batch no.').fill('AU1123');
  await page.getByLabel('Expiry').fill('03/2027');
  await page.getByLabel('Quantity').fill('2b');
  await page.getByRole('button', { name: 'Add stock' }).click();
  await expect(page.getByText('Stock added')).toBeVisible();
  await addStaff(page, 'Sana', 'Cashier', '1470');
  await switchUser(page, 'Sana', '1470');
  await page.keyboard.press('Alt+5');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1' })).toBeVisible();
  await page.keyboard.press('Alt+1');

  // A cashier gives a box away: 100% off is above her 5%, so Pay asks for the owner's PIN.
  const scan = page.getByLabel('Scan or search');
  await scan.fill('8961234567890');
  await scan.press('Enter');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 1,309.00');
  await page.keyboard.press('F6');
  await page.keyboard.type('100');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 0.00');
  await page.keyboard.press('F9');
  const pin = page.getByLabel('Their PIN');
  await expect(pin).toBeFocused();
  await pin.fill(OWNER_PIN);
  await pin.press('Enter');

  // After the approval there is no cash box; Enter still finishes, as the dialog says.
  await expect(page.getByText('Nothing to pay — press Enter to finish')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete sale' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Invoice T1-000001', { exact: true })).toBeVisible();
  await expect(page.getByTestId('change-due')).toHaveText('Rs 0.00');
  expect(problems).toEqual([]);
});
