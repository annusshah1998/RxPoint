import { expect, test } from '@playwright/test';
import { addStaff, setUpTill, switchUser } from './helpers';

test('open a shift with a note count, pay out, and close blind with a note', async ({ page }) => {
  const problems = await setUpTill(page);
  await addStaff(page, 'Sana', 'Cashier', '1470');
  await switchUser(page, 'Sana', '1470');

  await page.getByRole('link', { name: 'Shift' }).click();
  await expect(page.getByRole('heading', { name: 'No shift is open' })).toBeVisible();
  await expect(page.getByLabel('Cash in the drawer')).toHaveValue('5000.00');
  await page.getByRole('button', { name: 'Count notes' }).click();
  await page.getByLabel('Rs 1,000 ×').fill('4');
  await page.getByLabel('Rs 500 ×').fill('2');
  await expect(page.getByText('Total: Rs 5,000.00')).toBeVisible();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1' })).toBeVisible();

  // Rs 150 for tea.
  await page.getByRole('button', { name: 'Cash out' }).click();
  await page.getByLabel('Amount').fill('150');
  await page.getByLabel('Note').fill('Tea for staff');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByRole('row', { name: /Cash out/ })).toContainText('-Rs 150.00');
  // The cashier counts blind.
  await expect(page.getByRole('row', { name: /Expected in drawer/ })).toContainText(
    'Shown after the count',
  );

  // A pay-out over the limit needs a pharmacist's or the owner's PIN.
  await page.getByRole('button', { name: 'Cash out' }).click();
  await page.getByLabel('Amount').fill('2500');
  await page.getByLabel('Note').fill('Paid distributor');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('This needs a PIN from a pharmacist or the owner.')).toBeVisible();
  await page.getByLabel('Their PIN').fill('246810');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByRole('row', { name: /Cash out/ })).toContainText('-Rs 2,650.00');

  // Close: Rs 2,200 counted against Rs 2,350 expected.
  await page.getByRole('button', { name: 'Close shift' }).click();
  await page.getByLabel('Rs 1,000 ×').fill('2');
  await page.getByLabel('Rs 100 ×').fill('2');
  await page.getByLabel('Leave in the drawer for the next shift').fill('2000');
  await page.getByRole('dialog').getByRole('button', { name: 'Close shift' }).click();
  await expect(
    page.getByText('The drawer is Rs 150.00 short. Say why before closing.'),
  ).toBeVisible();
  await page.getByRole('dialog').getByLabel('Note').fill('Gave extra change');
  await page.getByRole('dialog').getByRole('button', { name: 'Close shift' }).click();

  await expect(page.getByRole('heading', { name: 'Shift 1 closed' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Expected in drawer/ })).toContainText('Rs 2,350.00');
  await expect(page.getByRole('row', { name: /Difference/ })).toContainText('-Rs 150.00');

  // The next shift starts from what was left.
  await page.getByRole('button', { name: 'Open next shift' }).click();
  await expect(page.getByLabel('Cash in the drawer')).toHaveValue('2000.00');
  expect(problems).toEqual([]);
});
