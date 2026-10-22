import { expect, test } from '@playwright/test';
import { setUpTill } from './helpers';

test('the owner sets the pharmacy details and checkout rules', async ({ page }) => {
  const problems = await setUpTill(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Address').fill('12 Main Bazar, Lahore');
  await page.getByLabel('Drug licence no.').fill('01-352-0001-23456P');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText('Saved').first()).toBeVisible();

  await page.getByLabel('Cashier can give up to (%)').fill('7.5');
  await page.getByLabel('Round bills').selectOption({ label: 'To Rs 5' });
  await page.getByLabel('Footer line').fill('Fridge items are not returnable');
  await page.getByRole('button', { name: 'Save' }).nth(1).click();
  await expect(page.getByText('Saved').nth(1)).toBeVisible();

  // Kept after a reload.
  await page.reload();
  await page.getByLabel('PIN for Annus').fill('246810');
  await page.getByLabel('PIN for Annus').press('Enter');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByLabel('Cashier can give up to (%)')).toHaveValue('7.5');
  await expect(page.getByLabel('Drug licence no.')).toHaveValue('01-352-0001-23456P');

  // Backups run only in the desktop app.
  await page.getByRole('link', { name: 'Backups' }).click();
  await expect(page.getByText('Backups run in the desktop app.', { exact: false })).toBeVisible();
  expect(problems).toEqual([]);
});
