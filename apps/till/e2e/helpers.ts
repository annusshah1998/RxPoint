import { expect, type Page } from '@playwright/test';

/** Opens a fresh till (each test has its own browser storage) and runs first-time setup. */
export async function setUpTill(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.goto('/');
  await page.getByLabel('Pharmacy name').fill('Shifa Pharmacy');
  await page.getByLabel('Owner name').fill('Annus');
  await page.getByRole('button', { name: 'Start using the till' }).click();
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  return problems;
}

/** Creates Augmentin 625mg: Tablet, Strip of 6, Box of 3 strips; priced per strip. */
export async function createAugmentin(page: Page) {
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Brand name').fill('Augmentin');
  await page.getByLabel('Strength', { exact: true }).first().fill('625mg');
  await page.getByLabel('Manufacturer').fill('GSK');
  await page.getByLabel('Generic (salt) 1').fill('Amoxicillin');
  await page.getByLabel('Strength', { exact: true }).nth(1).fill('500mg');
  await page.getByRole('button', { name: 'Add salt' }).click();
  await page.getByLabel('Generic (salt) 2').fill('Clavulanic Acid');
  await page.getByLabel('Strength', { exact: true }).nth(2).fill('125mg');

  await page.getByLabel('Holds (tablets) 2').fill('6');
  await page.getByRole('button', { name: 'Add pack size' }).click();
  await page.getByLabel('Holds (tablets) 3').fill('18');
  await page.getByLabel('Barcodes Box').fill('8961234567890');

  await page.getByLabel('Sale price').fill('436.20');
  await page.getByLabel('per', { exact: true }).selectOption({ label: 'Strip' });
  await page.getByLabel(/Usual cost price/).fill('370.77');
  await page.getByLabel('Controlled drug').selectOption({ label: 'Not controlled' });
  await page.getByLabel('Rack / shelf').fill('B2');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: /Augmentin 625mg/ })).toBeVisible();
}
