import { expect, test } from '@playwright/test';
import { createAugmentin, setUpTill } from './helpers';

test('create a product, find it, and record its stock', async ({ page }) => {
  const problems = await setUpTill(page);
  await expect(page.getByText('No products yet')).toBeVisible();

  await createAugmentin(page);

  // Prices for every pack size come from the strip price.
  await expect(page.getByText('1 Box = 3 Strips = 18 Tablets')).toBeVisible();
  await expect(page.getByText('1 Box: Rs 1,308.60')).toBeVisible();
  await expect(page.getByText('1 Tablet: Rs 72.70')).toBeVisible();
  await expect(page.getByText('Amoxicillin 500mg + Clavulanic Acid 125mg')).toBeVisible();

  // Opening stock: 1 box and 2 loose tablets, typed the quick way.
  await page.getByLabel('Batch no.').fill('AU1123');
  await page.getByLabel('Expiry').fill('03/2027');
  await expect(page.getByText('Mar 2027')).toBeVisible();
  await page.getByLabel('Quantity').fill('1b 2t');
  await expect(page.getByText('= 1 Box, 2 Tablets')).toBeVisible();
  await page.getByRole('button', { name: 'Add stock' }).click();
  await expect(page.getByText('Stock added')).toBeVisible();
  await expect(page.getByTestId('stock-on-hand')).toHaveText('1 Box, 2 Tablets');

  // Correct it: two tablets were damaged.
  await page.getByRole('button', { name: 'Adjust' }).click();
  const dialog = page.getByRole('dialog', { name: 'Adjust stock' });
  await dialog.getByLabel('Quantity').fill('2');
  await dialog.getByLabel('Reason').fill('Damaged');
  await dialog.getByRole('button', { name: 'Save adjustment' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('stock-on-hand')).toHaveText('1 Box');

  // Search by salt, then by scanning the box barcode.
  await page.getByRole('link', { name: 'Products' }).click();
  const search = page.getByLabel('Search products');
  await search.fill('clav');
  await expect(page.getByRole('row', { name: /Augmentin 625mg/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Augmentin 625mg/ })).toContainText('1 Box');
  await search.fill('no such medicine');
  await expect(page.getByText('No products match your search.')).toBeVisible();
  await search.fill('8961234567890');
  await search.press('Enter');
  await expect(page.getByRole('heading', { name: /Augmentin 625mg/ })).toBeVisible();

  expect(problems).toEqual([]);
});

test('show field errors from the product form', async ({ page }) => {
  await setUpTill(page);
  await createAugmentin(page);

  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Brand name').fill('Fake Box');
  await page.getByLabel('Sale price').fill('abc');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Enter a price, e.g. 245.50').first()).toBeVisible();

  await page.getByLabel('Sale price').fill('100');
  await page.getByLabel('Barcodes Strip').fill('8961234567890');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Barcode 8961234567890 already belongs to Augmentin')).toBeVisible();
  await expect(page.getByText('Already used by Augmentin')).toBeVisible();
});

test('suggest a maker and salt under their boxes, by keyboard or mouse', async ({ page }) => {
  const problems = await setUpTill(page);
  await createAugmentin(page);
  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Brand name').fill('Amoxil');

  // Typing opens the till's own list (not the browser's), just under the box.
  const maker = page.getByLabel('Manufacturer');
  const suggestions = page.getByRole('listbox', { name: 'Suggestions' });
  await maker.fill('gs');
  await expect(suggestions.getByRole('option')).toHaveText(['GSK']);
  await expect(suggestions).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const listSitsUnderBox = async () => {
    const box = (await maker.boundingBox())!;
    const list = (await suggestions.boundingBox())!;
    expect(Math.abs(list.x - box.x)).toBeLessThan(2);
    expect(list.y).toBeGreaterThanOrEqual(box.y + box.height);
    expect(list.y).toBeLessThan(box.y + box.height + 12);
    return box.y;
  };
  const top = await listSitsUnderBox();

  // Scrolling the form carries the list along with its box.
  await page.locator('.main').evaluate((el) => el.scrollBy(0, 120));
  await expect.poll(async () => (await maker.boundingBox())!.y).toBeLessThan(top);
  await listSitsUnderBox();

  // ↓ highlights a name and Enter picks it, without saving the form.
  await maker.press('ArrowDown');
  await expect(suggestions.getByRole('option', { name: 'GSK' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await maker.press('Enter');
  await expect(maker).toHaveValue('GSK');
  await expect(suggestions).toBeHidden();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Escape closes the list and keeps what was typed.
  const salt = page.getByLabel('Generic (salt) 1');
  await salt.fill('a');
  await expect(suggestions.getByRole('option')).toHaveText(['Amoxicillin', 'Clavulanic Acid']);
  await salt.press('Escape');
  await expect(suggestions).toBeHidden();
  await expect(salt).toHaveValue('a');

  // A click picks a name too.
  await salt.fill('clav');
  await suggestions.getByRole('option', { name: 'Clavulanic Acid' }).click();
  await expect(salt).toHaveValue('Clavulanic Acid');
  await expect(suggestions).toBeHidden();

  // A new name can still be typed, and the product saves.
  await maker.fill('Brand New Pharma');
  await expect(suggestions).toBeHidden();
  await page.getByLabel('Sale price').fill('120');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: /Amoxil/ })).toBeVisible();
  expect(problems).toEqual([]);
});

test('edit a price and keep the change in the product', async ({ page }) => {
  await setUpTill(page);
  await createAugmentin(page);
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Sale price').fill('450');
  await page.getByLabel('Reason for price change').fill('New DRAP price');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('1 Strip: Rs 450.00')).toBeVisible();
});

test('stock screen shows expiry risk', async ({ page }) => {
  await setUpTill(page);
  await createAugmentin(page);

  const addBatch = async (batch: string, expiry: string, qty: string) => {
    await page.getByLabel('Batch no.').fill(batch);
    await page.getByLabel('Expiry').fill(expiry);
    await page.getByLabel('Quantity').fill(qty);
    await page.getByRole('button', { name: 'Add stock' }).click();
    await expect(page.getByText('Stock added')).toBeVisible();
  };
  await addBatch('OLD1', '01/2020', '6'); // long expired
  await expect(page.getByText('This batch has already expired')).toBeVisible();
  await addBatch('NEW1', '12/2099', '1 box');

  await page.getByRole('link', { name: 'Stock & expiry' }).click();
  await expect(page.getByRole('heading', { name: 'Stock & expiry' })).toBeVisible();
  // 6 tablets at Rs 370.77 per strip of 6.
  await expect(page.locator('.summary-bad .stat')).toHaveText('Rs 370.77');
  await page.getByRole('tab', { name: 'Expired' }).click();
  await expect(page.getByRole('row', { name: /OLD1/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /NEW1/ })).toBeHidden();
});
