import { expect, test, type Page } from '@playwright/test';
import { addStaff, logIn, setUpTill } from './helpers';

async function newProduct(page: Page, name: string, price: string, schedule: string | null) {
  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Brand name').fill(name);
  await page.getByLabel('Strength', { exact: true }).first().fill('5mg');
  await page.getByLabel('Generic (salt) 1').fill(name === 'Valium' ? 'Diazepam' : 'Paracetamol');
  await page.getByLabel('Sale price').fill(price);
  await page.getByLabel('Controlled drug').selectOption({
    label: schedule ? `Schedule ${schedule}` : 'Not controlled',
  });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`^${name}`) })).toBeVisible();
}

test('a cashier sells a controlled drug and gives a big discount with a pharmacist’s PIN', async ({
  page,
}) => {
  const problems = await setUpTill(page);
  await addStaff(page, 'Hina', 'Pharmacist', '2580');
  await addStaff(page, 'Sana', 'Cashier', '1470');
  await newProduct(page, 'Valium', '50', 'B');
  await newProduct(page, 'Calpol', '120', null);

  await page.getByRole('button', { name: 'Lock' }).click();
  await logIn(page, 'Sana', '1470');
  await page.getByRole('link', { name: 'Shift' }).click();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await page.getByRole('link', { name: 'Sale', exact: true }).click();

  const scan = page.getByLabel('Scan or search');
  await scan.fill('valium');
  await expect(page.getByRole('option', { name: /Valium 5mg/ })).toBeVisible();
  await scan.press('Enter');
  await expect(page.getByRole('row', { name: /Valium 5mg/ })).toContainText('Controlled (B)');

  // No batch on record: type it from the pack.
  await page.keyboard.press('F4');
  await page.getByLabel('Batch no. on the pack').fill('VX221');
  await page.getByLabel('Expiry on the pack').fill('12/2027');
  await page.getByRole('button', { name: 'Use this batch' }).click();
  await expect(page.getByRole('row', { name: /Valium 5mg/ })).toContainText('VX221');

  // 10% off Calpol: above the cashier's 5% limit.
  await scan.fill('calpol');
  await expect(page.getByRole('option', { name: /Calpol 5mg/ })).toBeVisible();
  await scan.press('Enter');
  await page.keyboard.press('F6');
  await page.getByLabel('Discount', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('sale-total')).toContainText('Rs 158.00');

  // Pay: the discount needs Hina's PIN first.
  await page.keyboard.press('F9');
  await expect(page.getByText(/10% discount/)).toBeVisible();
  await page.getByLabel('Approved by').selectOption({ label: 'Hina' });
  await page.getByLabel('Their PIN').fill('2580');
  await page.getByRole('button', { name: 'Approve' }).click();

  // The prescription for the controlled drug, then Hina's PIN to dispense it.
  await page.getByLabel('Patient name').fill('Ali Raza');
  await page.getByLabel('Doctor').fill('Dr Khan');
  await page.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByText('This needs a PIN from a pharmacist or the owner.')).toBeVisible();
  await page.getByLabel('Approved by').selectOption({ label: 'Hina' });
  await page.getByLabel('Their PIN').fill('2580');
  await page.getByRole('button', { name: 'Approve' }).click();

  await expect(page.getByText('Invoice T1-000001', { exact: true })).toBeVisible();
  await expect(page.getByTestId('receipt-preview')).toContainText('Rx: Ali Raza - Dr Khan');
  await expect(page.getByTestId('receipt-preview')).toContainText('Batch VX221 Exp Dec 2027');
  expect(problems).toEqual([]);
});
