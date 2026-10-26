import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakePrinter, type FakePrinter } from '../../../scripts/fake-printer.mjs';
import { createAugmentin, OWNER_PIN, setUpTill } from './helpers';

// Printing from the browser preview: Network jobs go through the dev server's bridge
// (dev-printer-bridge.ts) to scripts/fake-printer.mjs, which each test starts on a free
// port. The desktop app sends the same bytes through Rust's print_raw.

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const DRAWER_PIN_2 = '1B 40 1B 70 00 19 FA';

const printers: FakePrinter[] = [];
const dirs: string[] = [];
async function fakePrinter(port = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'printer-spec-'));
  dirs.push(dir);
  const printer = await startFakePrinter({ port, outDir: dir, quiet: true });
  printers.push(printer);
  return printer;
}
test.afterEach(async () => {
  await Promise.all(printers.splice(0).map((p) => p.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function printerCard(page: Page) {
  return page
    .locator('section.card')
    .filter({ has: page.getByRole('heading', { name: 'This till’s printer' }) });
}

/** Settings → This till's printer: Network on 127.0.0.1:`port`, drawer on pin 2. */
async function useNetworkPrinter(page: Page, port: number) {
  await page.getByRole('link', { name: 'Settings' }).click();
  const card = printerCard(page);
  await card.getByLabel('Printing').selectOption({ label: 'Network printer' });
  await card.getByLabel('IP address').fill('127.0.0.1');
  await card.getByLabel('Port').fill(String(port));
  await card.getByLabel('Cash drawer plugged into the printer').check();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Saved')).toBeVisible();
}

/** Augmentin in stock, a shift open, and the Sale screen. */
async function stockAndShift(page: Page) {
  await page.getByRole('link', { name: 'Products' }).click();
  await createAugmentin(page);
  await page.getByLabel('Batch no.').fill('AU1123');
  await page.getByLabel('Expiry').fill('03/2027');
  await page.getByLabel('Quantity').fill('3b');
  await page.getByRole('button', { name: 'Add stock' }).click();
  await expect(page.getByText('Stock added')).toBeVisible();
  await page.getByRole('link', { name: 'Shift' }).click();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1' })).toBeVisible();
  await page.getByRole('link', { name: 'Sale', exact: true }).click();
}

/** One Box of Augmentin (Rs 1,309.00) paid with Rs 2,000 cash. */
async function cashSale(page: Page) {
  const scan = page.getByLabel('Scan or search');
  await scan.fill('8961234567890');
  await scan.press('Enter');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 1,309.00');
  await page.keyboard.press('F9');
  await expect(page.getByLabel('Cash received')).toBeFocused();
  await page.keyboard.type('2000');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('change-due')).toHaveText('Rs 691.00');
}

async function logInAgain(page: Page) {
  await page.reload();
  await page.getByLabel('PIN for Annus').fill(OWNER_PIN);
  await page.getByLabel('PIN for Annus').press('Enter');
}

test('printing is off by default: the test page shows on screen', async ({ page }) => {
  const problems = await setUpTill(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  const card = printerCard(page);
  await expect(card.getByLabel('Printing')).toHaveValue('off');
  await expect(card.getByLabel('Characters per line')).toHaveValue('48');
  await expect(card.getByRole('button', { name: 'Test drawer' })).toBeDisabled();

  await card.getByRole('button', { name: 'Print test page' }).click();
  const preview = page.getByRole('dialog', { name: 'Test page' }).getByTestId('receipt-preview');
  await expect(preview).toContainText('P R I N T E R   T E S T');
  await expect(preview).toContainText('----+----1----+----2----+----3----+----4----+--|');
  await expect(preview).toContainText('*TEST123*');
  await page.keyboard.press('Escape');

  // A no-sale says to open the drawer by hand.
  await page.getByRole('link', { name: 'Shift' }).click();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await page.getByRole('button', { name: 'Open drawer' }).click();
  await expect(
    page.getByText('No drawer is set up on this till’s printer: open it by hand.'),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // Backups run only in the desktop app.
  await page.getByRole('link', { name: 'Backups' }).click();
  await expect(page.getByText('Backups run in the desktop app.', { exact: false })).toBeVisible();
  expect(problems).toEqual([]);
});

test('a cash sale prints with the drawer pulse first; a no-sale only opens the drawer', async ({
  page,
}) => {
  const printer = await fakePrinter();
  const problems = await setUpTill(page);
  await useNetworkPrinter(page, printer.port);

  // The test page and the drawer test, with the settings just saved.
  const card = printerCard(page);
  await card.getByRole('button', { name: 'Print test page' }).click();
  await expect(card.getByText('Test page sent to the printer.')).toBeVisible();
  await card.getByRole('button', { name: 'Test drawer' }).click();
  await expect(card.getByText('Drawer opened.')).toBeVisible();
  const [testPage, drawerTest] = await printer.waitForJobs(2);
  expect(testPage!.lines.map((l) => l.trim())).toEqual(
    expect.arrayContaining([
      '[bold]',
      '[large]',
      'PRINTER TEST',
      '----+----1----+----2----+----3----+----4----+--|',
      '[barcode CODE128 TEST123]',
      '--- cut ---',
    ]),
  );
  expect(hex(testPage!.bytes)).not.toContain('1B 70');
  expect(hex(drawerTest!.bytes)).toBe(DRAWER_PIN_2);

  // A cash sale: the change panel, then the receipt with the pulse right after init.
  await stockAndShift(page);
  await cashSale(page);
  await expect(page.getByText('Invoice T1-000001', { exact: true })).toBeVisible();
  await expect(page.getByTestId('print-status')).toHaveText('Receipt sent to the printer.');
  // The paper is the receipt: no preview unless asked for.
  await expect(page.getByTestId('receipt-preview')).toBeHidden();
  const receipt = (await printer.waitForJobs(3))[2]!;
  expect(hex(receipt.bytes.slice(0, 7))).toBe(DRAWER_PIN_2);
  expect(hex(receipt.bytes).split('1B 70').length).toBe(2);
  expect(receipt.lines.slice(0, 3)).toEqual([
    '[init]',
    '[drawer pin 2 (50 ms on, 500 ms off)]',
    '[code page 437]',
  ]);
  expect(receipt.lines.map((l) => l.trim())).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^Invoice T1-000001 +\d\d-\d\d-\d{4} \d\d:\d\d$/),
      'TOTAL Rs 1,309.00',
      'Cash received                           2,000.00',
      'Change                                    691.00',
      '[barcode CODE128 T1-000001]',
      '--- cut ---',
    ]),
  );
  expect(receipt.lines.every((l) => l.startsWith('[') || l.length <= 48)).toBe(true);

  // Enter starts the next sale; Alt+D records a no-sale and sends the pulse on its own.
  await page.keyboard.press('Enter');
  await expect(page.getByText('Scan an item or type its name to start.')).toBeVisible();
  await page.keyboard.press('Alt+d');
  const noSale = page.getByRole('dialog', { name: 'Open the drawer without a sale' });
  await expect(noSale.getByLabel('Reason')).toBeFocused();
  await expect(noSale.getByText('open it by hand', { exact: false })).toBeHidden();
  await page.keyboard.type('Change for a Rs 5,000 note');
  await page.keyboard.press('Enter');
  await expect(noSale).toBeHidden();
  const kick = (await printer.waitForJobs(4))[3]!;
  expect(hex(kick.bytes)).toBe(DRAWER_PIN_2);
  expect(kick.lines).toEqual(['[init]', '[drawer pin 2 (50 ms on, 500 ms off)]']);

  // Ctrl+P reprints the last receipt, marked REPRINT, without opening the drawer.
  await page.keyboard.press('Control+p');
  const reprint = page.getByRole('dialog', { name: 'Last receipt' });
  await expect(reprint.getByTestId('print-status')).toHaveText('Receipt sent to the printer.');
  const copy = (await printer.waitForJobs(5))[4]!;
  expect(copy.lines.map((l) => l.trim())).toContain('*** REPRINT ***');
  expect(hex(copy.bytes)).not.toContain('1B 70');
  await page.keyboard.press('Enter');
  await expect(reprint).toBeHidden();
  expect(problems).toEqual([]);
});

test('a failed print never blocks the sale, and the till asks about it after a restart', async ({
  page,
}) => {
  // A printer that is switched off: nothing listens on its port.
  const off = await fakePrinter();
  const port = off.port;
  await off.close();
  const problems = await setUpTill(page);
  await useNetworkPrinter(page, port);
  await stockAndShift(page);

  await cashSale(page);
  await expect(page.getByText('Invoice T1-000001', { exact: true })).toBeVisible();
  await expect(page.getByTestId('print-status')).toHaveText(
    `Receipt not printed: Printer not reachable at 127.0.0.1:${port}`,
  );
  const pay = page.getByRole('dialog', { name: 'Sale complete' });
  await expect(pay.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(pay.getByRole('button', { name: 'Show on screen' })).toBeVisible();
  // The pulse was in that receipt, so the drawer didn't open either.
  await expect(pay.getByText('Open the drawer by hand for the cash.')).toBeVisible();

  // The cashier moves on: the failure stays on screen above the next sale.
  await page.keyboard.press('Enter');
  await expect(page.getByText('Scan an item or type its name to start.')).toBeVisible();
  const bar = page.getByRole('region', { name: 'Printer problems' });
  await expect(bar).toContainText(
    `Receipt T1-000001 not printed: Printer not reachable at 127.0.0.1:${port}`,
  );

  // A power cut. At the next start the till asks about the receipt.
  await logInAgain(page);
  const notice = page.getByRole('region', { name: 'Receipt for T1-000001 may not have printed.' });
  await expect(notice).toContainText('Receipt for T1-000001 may not have printed.');
  await expect(notice.getByRole('button', { name: 'Skip' })).toBeVisible();

  // The printer is back on: Print sends the receipt (the cash was handled long ago, so
  // the drawer stays shut).
  const back = await fakePrinter(port);
  await notice.getByRole('button', { name: 'Print', exact: true }).click();
  await expect(notice.getByTestId('print-status')).toHaveText('Receipt sent to the printer.');
  const [job] = await back.waitForJobs(1);
  expect(job!.lines).toContain('[barcode CODE128 T1-000001]');
  expect(hex(job!.bytes)).not.toContain('1B 70');
  await logInAgain(page);
  await expect(page.getByRole('heading', { name: 'Sale' })).toBeVisible();
  await expect(page.getByText('may not have printed', { exact: false })).toBeHidden();

  // Off again: this time the cashier shows the receipt on screen, which settles it.
  await back.close();
  await cashSale(page);
  await expect(page.getByTestId('print-status')).toContainText('Receipt not printed');
  await page.getByRole('button', { name: 'Show on screen' }).click();
  await expect(page.getByTestId('receipt-preview')).toContainText('T1-000002');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Printer problems' })).toBeHidden();
  await logInAgain(page);
  await expect(page.getByRole('heading', { name: 'Sale' })).toBeVisible();
  await expect(page.getByText('may not have printed', { exact: false })).toBeHidden();
  expect(problems).toEqual([]);
});
