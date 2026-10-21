import { expect, test } from '@playwright/test';
import { setUpTill } from './helpers';

const CSV = [
  'Item Name,Salt,Company,Packing,Retail Price,TP,Batch No,Exp Date,Qty',
  'Panadol Tab 500mg,Paracetamol,GSK,20x10,520,442,PN01,06/2027,180',
  'Panadol Tab 500mg,Paracetamol,GSK,20x10,520,442,PN02,09/2027,200',
  'Brufen Syp 100mg/5ml,Ibuprofen,Abbott,,120,102,BR9,soon,5',
].join('\n');

test('import a distributor-style price list with stock', async ({ page }) => {
  const problems = await setUpTill(page);
  await page.getByRole('link', { name: 'Import' }).click();

  await page.locator('input[type=file]').setInputFiles({
    name: 'stock.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV),
  });

  // Columns are matched from the headers.
  await expect(page.getByLabel('Product name')).toHaveValue('0');
  await expect(page.getByLabel('Generic / salt')).toHaveValue('1');
  await expect(page.getByLabel('Expiry')).toHaveValue('7');
  await page.getByRole('button', { name: 'Check rows' }).click();

  await expect(
    page.getByText('1 new product · 0 already in catalog · 2 stock lines · 1 row with problems'),
  ).toBeVisible();
  await expect(page.getByText(`Can't read expiry "soon" (try 03/2027)`)).toBeVisible();

  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(
    page.getByText('1 product created, 2 stock lines added, 0 rows failed.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'View products' }).click();
  await page.getByLabel('Search products').fill('paracet');
  const row = page.getByRole('row', { name: /Panadol Tab 500mg/ });
  await expect(row).toContainText('1 Box, 18 Strips');
  await expect(row).toContainText('Rs 520.00 / Box');
  expect(problems).toEqual([]);
});
