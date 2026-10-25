import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addStaff, logIn } from './helpers';

/**
 * Takes the pictures in docs/user-guide/images. Not part of `pnpm test:e2e`: run
 * `pnpm docs:screenshots` after changing a screen, then check the guide still matches.
 *
 * It walks a day at the till: setup, import the sample stock, staff, a shift, sales,
 * a controlled drug, hold, return, void and closing the shift. Dates come from this PC's
 * clock. The browser-preview banner is hidden, since the desktop app has none.
 */
const OUT = fileURLToPath(new URL('../../../docs/user-guide/images/', import.meta.url));
const SAMPLE = fileURLToPath(new URL('../../../samples/sample-stock.csv', import.meta.url));
const WIDTH = 1366;
const HEIGHT = 768;

const OWNER = { name: 'Imran', pin: '246810' };
const PHARMACIST = { name: 'Hina', pin: '2580' };
const CASHIER = { name: 'Bilal', pin: '1470' };

test.setTimeout(300_000);

test('user guide screenshots', async ({ page }) => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '.preview-banner { display: none !important; }';
      document.head.append(style);
    });
  });
  const shot = (name: string, options?: ShotOptions) => screenshot(page, name, options);
  const dialog = page.getByRole('dialog');
  const main = page.locator('.main');

  // --- First start -------------------------------------------------------------------
  await page.goto('/');
  await page.getByLabel('Pharmacy name').fill('Shifa Pharmacy');
  await page.getByLabel('Address').fill('12 Mall Road, Lahore');
  await page.getByLabel('Phone').fill('042 3576 1234');
  await page.getByLabel('Owner name').fill(OWNER.name);
  await page.getByLabel('Owner PIN').fill(OWNER.pin);
  await page.getByLabel('Type the PIN again').fill(OWNER.pin);
  await shot('setup');
  await page.getByRole('button', { name: 'Start using the till' }).click();
  await expect(page.getByRole('heading', { name: 'Write down this recovery code' })).toBeVisible();
  await shot('recovery-code');
  await page.getByRole('button', { name: 'I have written it down' }).click();
  await expect(page.getByText('Open a shift to start selling')).toBeVisible();
  await shot('sale-no-shift');

  // --- Import the sample stock list ----------------------------------------------------
  await nav(page, 'Import');
  await shot('import-choose');
  await page.locator('input[type="file"]').setInputFiles(SAMPLE);
  await expect(page.getByText('2. Match columns')).toBeVisible();
  await shot('import-match');
  await page.getByRole('button', { name: 'Check rows' }).click();
  const run = page.getByRole('button', { name: /^Import \d+ rows?$/ });
  await expect(run).toBeVisible();
  await shot('import-check');
  await run.click();
  await expect(page.getByText('Import finished')).toBeVisible();
  await shot('import-done');

  // --- Products and stock --------------------------------------------------------------
  await nav(page, 'Products');
  await expect(page.getByText('Surbex-Z')).toBeVisible();
  await shot('products');
  const search = page.getByLabel('Search products');
  await search.fill('paracetamol');
  await expect(page.getByText('Calpol')).toBeVisible();
  await shot('products-search');
  await search.fill('');

  await page.getByRole('row', { name: /Panadol 500mg/ }).click();
  await expect(page.getByRole('heading', { name: /^Panadol 500mg/ })).toBeVisible();
  await shot('product-detail');
  await page.getByRole('button', { name: 'Adjust' }).first().click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Quantity').fill('1s');
  await dialog.getByLabel('Reason').fill('Strip torn');
  await shot('adjust-stock');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: /^Edit product/ })).toBeVisible();
  await shot('product-form', { target: main, tall: true });
  await page.getByRole('button', { name: 'Cancel' }).click();

  await nav(page, 'Products');
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Brand name').fill('Arinac');
  await page.getByLabel('Strength', { exact: true }).first().fill('200mg');
  await page.getByLabel('Manufacturer').fill('Abbott');
  await page.getByLabel('Generic (salt) 1').fill('Ibuprofen');
  await page.getByLabel('Strength', { exact: true }).nth(1).fill('200mg');
  await page.getByRole('button', { name: 'Add salt' }).click();
  await page.getByLabel('Generic (salt) 2').fill('Pseudoephedrine');
  await page.getByLabel('Strength', { exact: true }).nth(2).fill('30mg');
  await page.getByLabel('Holds (tablets) 2').fill('10');
  await page.getByRole('button', { name: 'Add pack size' }).click();
  await page.getByLabel('Holds (tablets) 3').fill('100');
  await page.getByLabel('Barcodes Box').fill('8960000000202');
  await page.getByLabel('Sale price').fill('280');
  await page.getByLabel('per', { exact: true }).selectOption({ label: 'Strip' });
  await page.getByLabel(/Usual cost price/).fill('238');
  await page.getByLabel('Controlled drug').selectOption({ label: 'Not controlled' });
  await page.getByLabel('Rack / shelf').fill('A2');
  await page.getByLabel('Brand name').focus();
  await shot('product-new', { target: main, tall: true });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: /^Arinac 200mg/ })).toBeVisible();
  await page.getByLabel('Batch no.').fill('AR2701');
  await page.getByLabel('Expiry').fill('01/2028');
  await page.getByLabel('Quantity').fill('5b');
  await page.getByLabel(/^Cost per/).fill('238');
  await shot('opening-stock', { target: page.locator('.card', { hasText: 'Add opening stock' }) });
  await page.getByRole('button', { name: 'Add stock' }).click();
  await expect(page.getByText('Stock added')).toBeVisible();

  await nav(page, 'Stock & expiry');
  await expect(page.getByText('Stock value (cost)')).toBeVisible();
  await shot('stock');
  await page.getByRole('tab', { name: 'Expiring soon' }).click();
  await shot('stock-expiring');

  // --- Staff and settings --------------------------------------------------------------
  await addStaff(page, PHARMACIST.name, 'Pharmacist', PHARMACIST.pin);
  await page.getByRole('button', { name: 'Add person' }).click();
  await dialog.getByLabel('Name').fill(CASHIER.name);
  await dialog.getByLabel('Role').selectOption({ label: 'Cashier' });
  await dialog.getByLabel('PIN', { exact: true }).fill(CASHIER.pin);
  await dialog.getByLabel('Type the PIN again').fill(CASHIER.pin);
  await shot('staff-add');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('cell', { name: CASHIER.name })).toBeVisible();
  await shot('staff');

  await nav(page, 'Settings');
  await expect(page.getByLabel('Round bills')).toBeVisible();
  await shot('settings', { target: main, tall: true });

  // --- Login and shift (as the cashier) ------------------------------------------------
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByRole('heading', { name: 'Who is using the till?' })).toBeVisible();
  await shot('login-pick');
  await page.getByRole('button', { name: new RegExp(`^${CASHIER.name}`) }).click();
  await page.getByLabel(`PIN for ${CASHIER.name}`).fill(CASHIER.pin);
  await shot('login');
  await page.getByLabel(`PIN for ${CASHIER.name}`).press('Enter');
  await expect(page.locator('.sidebar-footer').getByText(`· ${CASHIER.name}`)).toBeVisible();

  await nav(page, 'Shift');
  await expect(page.getByRole('heading', { name: 'No shift is open' })).toBeVisible();
  await shot('shift-open');
  await page.getByRole('button', { name: 'Count notes' }).click();
  await page.getByLabel('Rs 1,000 ×').fill('4');
  await page.getByLabel('Rs 500 ×').fill('1');
  await page.getByLabel('Rs 100 ×').fill('5');
  await shot('shift-count');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1' })).toBeVisible();

  // --- A sale --------------------------------------------------------------------------
  await nav(page, 'Sale', true);
  const scan = page.getByLabel('Scan or search');
  await expect(scan).toBeFocused();
  await shot('sale-empty');
  await scan.fill('pana');
  await expect(page.getByRole('option', { name: /Panadol 500mg/ })).toBeVisible();
  await shot('sale-search');
  await scan.press('Enter');
  await expect(page.getByRole('row', { name: /Panadol 500mg/ })).toBeVisible();
  await scan.fill('8960000000028'); // a strip of Augmentin, as a scanner would type it
  await scan.press('Enter');
  await expect(page.getByRole('row', { name: /Augmentin 625mg/ })).toBeVisible();
  await scan.fill('2*calpol');
  await expect(page.getByRole('option', { name: /Calpol/ })).toBeVisible();
  await scan.press('Enter');
  await expect(page.getByRole('row', { name: /Calpol/ })).toBeVisible();
  await scan.fill('ponstan');
  await expect(page.getByRole('option', { name: /Ponstan/ })).toBeVisible();
  await scan.press('Enter');
  await expect(page.getByRole('row', { name: /Ponstan/ })).toBeVisible();
  await expect(page.getByTestId('sale-total')).toContainText('Rs');
  await shot('sale-cart');

  // F4 on Panadol: pick the batch.
  await scan.press('ArrowUp');
  await scan.press('ArrowUp');
  await scan.press('ArrowUp');
  await page.keyboard.press('F4');
  await expect(page.getByRole('button', { name: 'Automatic (first to expire)' })).toBeVisible();
  await shot('batch-picker');
  await page.keyboard.press('Escape');

  // F6 on Augmentin: a 5% line discount (the cashier's limit).
  await scan.press('ArrowDown');
  await page.keyboard.press('F6');
  await expect(dialog.getByLabel('Discount', { exact: true })).toBeFocused();
  await page.keyboard.type('5');
  await shot('discount');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();

  // F9: part by JazzCash, the rest in cash.
  await page.keyboard.press('F9');
  await expect(page.getByTestId('pay-total')).toBeVisible();
  await expect(dialog.getByLabel('Cash received')).toBeFocused();
  await page.keyboard.press('Alt+Y');
  await expect(page.getByRole('button', { name: 'Seen', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog.getByLabel('Cash received')).toBeFocused();
  await shot('pay');
  await dialog.getByRole('button', { name: '+ Wallet' }).click();
  await dialog.getByLabel('Amount', { exact: true }).fill('500');
  await dialog.getByLabel('Transaction ID').fill('83920417');
  await dialog.getByLabel('Money received — I checked the app or SMS').check();
  await dialog.getByLabel('Cash received').fill('400');
  await shot('pay-split');
  await dialog.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByTestId('change-due')).toBeVisible();
  await shot('sale-done', { tall: true });
  await page.keyboard.press('Enter');
  await expect(page.getByText('Scan an item or type its name to start.')).toBeVisible();

  // Expired stock on record: Disprin's only batch has expired.
  await scan.fill('disprin');
  await expect(page.getByRole('option', { name: /Disprin/ })).toBeVisible();
  await scan.press('Enter');
  await expect(page.getByRole('row', { name: /Disprin/ })).toBeVisible();
  await page.keyboard.press('F9');
  await expect(page.getByText('Check the packs are in date')).toBeVisible();
  await shot('pay-in-date');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Hold it and look at the held list.
  await page.keyboard.press('F8');
  await expect(dialog.getByLabel('Note (optional)')).toBeFocused();
  await page.keyboard.type('Man in grey shalwar kameez');
  await shot('hold');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Scan an item or type its name to start.')).toBeVisible();
  await page.keyboard.press('Shift+F8');
  await expect(page.getByText('Man in grey shalwar kameez')).toBeVisible();
  await shot('held');
  await page.keyboard.press('Escape');

  // --- A controlled drug: batch from the pack, prescription, pharmacist's PIN -----------
  await scan.fill('xanax');
  await expect(page.getByRole('option', { name: /Xanax/ })).toBeVisible();
  await scan.press('Enter');
  await expect(page.getByRole('row', { name: /Xanax/ })).toContainText('Controlled (B)');
  await shot('sale-controlled');
  await page.keyboard.press('F4');
  await expect(
    page.getByText('Controlled drug: pick the batch printed on the pack in hand.'),
  ).toBeVisible();
  await shot('batch-controlled');
  await dialog.getByRole('button', { name: /XN2614/ }).click();
  await page.keyboard.press('F9');
  await dialog.getByLabel('Patient name').fill('Ayesha Khan');
  await dialog.getByLabel('Doctor').fill('Dr Tariq Mehmood');
  await dialog.getByLabel('Cash received').fill('500');
  await shot('pay-controlled');
  await dialog.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByText('This needs a PIN from a pharmacist or the owner.')).toBeVisible();
  await dialog.getByLabel('Approved by').selectOption({ label: PHARMACIST.name });
  await dialog.getByLabel('Their PIN').fill(PHARMACIST.pin);
  await shot('approval');
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('change-due')).toBeVisible();
  await shot('sale-done-controlled', { tall: true });
  await page.keyboard.press('Enter');

  // --- Sales list, return and void -----------------------------------------------------
  await nav(page, 'Sales');
  await page.getByRole('button', { name: 'T1-000001' }).click();
  await expect(dialog.getByRole('button', { name: 'Return items' })).toBeVisible();
  await shot('sale-detail');
  await dialog.getByRole('button', { name: 'Return items' }).click();
  await dialog.getByLabel(/^Return now: Calpol/).fill('1');
  await dialog
    .getByLabel('Why is it coming back?')
    .selectOption({ label: 'Doctor changed the medicine' });
  await expect(page.getByTestId('return-total')).toContainText('Rs');
  await dialog.getByLabel('Approved by').selectOption({ label: PHARMACIST.name });
  await dialog.getByLabel('Their PIN').fill(PHARMACIST.pin);
  await shot('return', { tall: true });
  await dialog.getByRole('button', { name: /^Return and refund/ }).click();
  await expect(dialog.getByText(/^Return .* recorded$/)).toBeVisible();
  await shot('return-done', { tall: true });
  await dialog.getByRole('button', { name: 'Close' }).last().click();

  await page.getByRole('button', { name: 'T1-000002' }).click();
  await dialog.getByRole('button', { name: 'Void sale' }).click();
  await dialog.getByLabel('Reason').fill('Rang up twice');
  await dialog.getByRole('button', { name: 'Void sale' }).click();
  await expect(dialog.getByText('This needs a PIN from')).toBeVisible();
  await dialog.getByLabel('Approved by').selectOption({ label: PHARMACIST.name });
  await dialog.getByLabel('Their PIN').fill(PHARMACIST.pin);
  await shot('void');
  await dialog.getByRole('button', { name: 'Void sale' }).click();
  await expect(dialog.getByText('Sale voided')).toBeVisible();
  await shot('void-done');
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(page.getByRole('row', { name: /T1-000002/ })).toContainText('Voided');
  await shot('sales');

  // --- Shift: cash out, report and close -----------------------------------------------
  await nav(page, 'Shift');
  await expect(page.getByRole('heading', { name: 'Shift 1' })).toBeVisible();
  await shot('shift');
  await page.getByRole('button', { name: 'Cash out' }).click();
  await dialog.getByLabel('Amount').fill('150');
  await dialog.getByLabel('Note').fill('Tea for staff');
  await shot('cash-out');
  await dialog.getByRole('button', { name: 'Record' }).click();
  await expect(dialog).toBeHidden();

  // Expected in the drawer: 5,000 float + 470 cash sales − 185 refund − 110 void − 150 out
  // = 5,025. Counting 4,900 leaves it Rs 125 short, which needs a note.
  await page.getByRole('button', { name: 'Close shift' }).click();
  await expect(page.getByRole('heading', { name: 'Close the shift' })).toBeVisible();
  await dialog.getByLabel('Rs 1,000 ×').fill('4');
  await dialog.getByLabel('Rs 500 ×').fill('1');
  await dialog.getByLabel('Rs 100 ×').fill('4');
  await dialog.getByLabel('Leave in the drawer for the next shift').fill('4000');
  await shot('shift-close');
  await dialog.getByRole('button', { name: 'Close shift' }).click();
  await expect(dialog.getByText(/short\. Say why before closing/)).toBeVisible();
  await dialog.getByLabel('Note').fill('Gave Rs 125 too much change by mistake');
  await shot('shift-close-short');
  await dialog.getByRole('button', { name: 'Close shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1 closed' })).toBeVisible();
  await shot('shift-closed', { target: main });

  // Back to the owner.
  await page.getByRole('button', { name: 'Lock' }).click();
  await logIn(page, OWNER.name, OWNER.pin);
  await expect(page.locator('.sidebar-footer').getByText(`· ${OWNER.name}`)).toBeVisible();
});

/** Goes to a screen with the sidebar. */
async function nav(page: Page, label: string, exact = false) {
  await page.getByRole('link', { name: label, exact }).click();
}

interface ShotOptions {
  /** Only this part of the page. */
  target?: Locator;
  /** Make the window tall enough for the whole screen, dialog or receipt, then put it back. */
  tall?: boolean;
}

async function screenshot(page: Page, name: string, { target, tall }: ShotOptions = {}) {
  // Let debounced searches and focus rings settle.
  await page.waitForTimeout(300);
  if (tall) {
    const height = await page.evaluate(() => {
      // Show the whole receipt rather than its scroll box.
      for (const pre of document.querySelectorAll<HTMLElement>('.receipt-preview')) {
        pre.style.maxHeight = 'none';
      }
      const main = document.querySelector('.main');
      main?.scrollTo(0, 0);
      const modal = document.querySelector('.modal');
      return Math.max(main?.scrollHeight ?? 0, modal ? modal.scrollHeight + 48 : 0);
    });
    await page.setViewportSize({ width: WIDTH, height: Math.min(Math.max(height, HEIGHT), 2000) });
    await page.waitForTimeout(200);
  }
  const path = `${OUT}${name}.png`;
  const options = { path, animations: 'disabled', caret: 'hide' } as const;
  if (target) await target.screenshot(options);
  else await page.screenshot(options);
  if (tall) await page.setViewportSize({ width: WIDTH, height: HEIGHT });
}
