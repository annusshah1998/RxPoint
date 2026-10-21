import { expect, type Page } from '@playwright/test';

export const OWNER_PIN = '246810';

/**
 * Opens a fresh till (each test has its own browser storage), runs first-time setup and
 * confirms the recovery code. Returns page errors seen so far (should stay empty).
 */
export async function setUpTill(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.goto('/');
  await page.getByLabel('Pharmacy name').fill('Shifa Pharmacy');
  await page.getByLabel('Owner name').fill('Annus');
  await page.getByLabel('Owner PIN').fill(OWNER_PIN);
  await page.getByLabel('Type the PIN again').fill(OWNER_PIN);
  await page.getByRole('button', { name: 'Start using the till' }).click();
  await expect(page.getByRole('heading', { name: 'Write down this recovery code' })).toBeVisible();
  await page.getByRole('button', { name: 'I have written it down' }).click();
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  return problems;
}

/** Logs in from the login screen. */
export async function logIn(page: Page, name: string, pin: string) {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await page.getByLabel(`PIN for ${name}`).fill(pin);
  await page.getByLabel(`PIN for ${name}`).press('Enter');
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
