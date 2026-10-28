import { expect, test, type Page } from '@playwright/test';
import { addBatch, createAugmentin, createCalpol, openShift, setUpTill } from './helpers';

// A USB scanner types a few ms per key and presses Enter; 60 ms a key is a person typing
// the same digits.
const SCAN_GAP_MS = 5;
const BY_HAND = 60;
const AUGMENTIN_BOX = '8961234567890';
const CALPOL_STRIP = '8964000000017';

/**
 * Types `code` and Enter wherever the cursor is, as a scanner does: real key events, each
 * stamped 5 ms after the last. page.keyboard.type waits for the page between keys, so a busy
 * page (a price check, other tests running) would stretch the gaps; a real scanner's keys
 * are timed as they arrive, however busy the page is.
 */
async function scanBurst(page: Page, code: string) {
  const cdp = await page.context().newCDPSession(page);
  const start = Date.now() / 1000;
  for (const [i, key] of [...code, 'Enter'].entries()) {
    const timestamp = start + (i * SCAN_GAP_MS) / 1000;
    const keyInfo =
      key === 'Enter'
        ? { key, code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }
        : { key, code: `Digit${key}`, windowsVirtualKeyCode: key.charCodeAt(0), text: key };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyInfo, timestamp });
    const { text: _text, ...up } = keyInfo;
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...up, timestamp });
  }
  await cdp.detach();
}

test('a barcode in the quantity or discount box adds that item and leaves the line alone', async ({
  page,
}) => {
  const problems = await setUpTill(page);
  await createAugmentin(page);
  await createCalpol(page);
  await openShift(page);

  const scan = page.getByLabel('Scan or search');
  const augmentin = page.getByRole('row', { name: /Augmentin 625mg/ });
  const calpol = page.getByRole('row', { name: /Calpol 5mg/ });
  // Bursts wait for the total: the price check after a change can hold up the page (in a
  // test, a stall between typed keys looks like a person typing).
  const total = page.getByTestId('sale-total');
  await scan.fill('2s*augm');
  await scan.press('Enter');
  await expect(augmentin).toContainText('2 Strips');

  // Enter on the empty scan box changes the selected line's quantity, the quick way.
  await scan.press('Enter');
  const qtyDialog = page.getByRole('dialog', { name: 'Quantity of Augmentin 625mg' });
  const qty = qtyDialog.getByLabel('Quantity', { exact: true });
  await expect(qty).toHaveValue('2 Strips');
  await qty.fill('1b');
  await expect(qtyDialog.getByText('= 1 Box')).toBeVisible();
  await qty.press('Enter');
  await expect(qtyDialog).toBeHidden();
  await expect(augmentin).toContainText('1 Box');

  // A barcode typed slowly into Qty is still a scan: Calpol is added, Augmentin stays 1 Box.
  await scan.press('Enter');
  await qty.fill('');
  await qty.pressSequentially(CALPOL_STRIP, { delay: BY_HAND });
  await qty.press('Enter');
  await expect(qtyDialog).toBeHidden();
  await expect(calpol).toContainText('1 Strip');
  await expect(augmentin).toContainText('1 Box');
  await expect(scan).toBeFocused();
  await expect(total).toContainText('Rs 1,429.00');

  // A scan burst into Qty (Calpol is now selected): one more box of Augmentin.
  await scan.press('Enter');
  const calpolQty = page.getByRole('dialog', { name: 'Quantity of Calpol 5mg' });
  await expect(calpolQty.getByLabel('Quantity', { exact: true })).toBeFocused();
  await scanBurst(page, AUGMENTIN_BOX);
  await expect(calpolQty).toBeHidden();
  await expect(augmentin).toContainText('2 Boxes');
  await expect(calpol).toContainText('1 Strip');
  await expect(total).toContainText('Rs 2,737.00');

  // The same in the discount box (F6 on the selected line, Augmentin after that scan).
  await page.keyboard.press('F6');
  const discountDialog = page.getByRole('dialog', { name: 'Discount on Augmentin 625mg' });
  const discount = discountDialog.getByLabel('Discount');
  await discount.pressSequentially(CALPOL_STRIP, { delay: BY_HAND });
  await discount.press('Enter');
  await expect(discountDialog).toBeHidden();
  await expect(calpol).toContainText('2 Strips');
  await expect(total).toContainText('Rs 2,857.00');

  await page.keyboard.press('F6');
  await expect(page.getByRole('dialog', { name: 'Discount on Calpol 5mg' })).toBeVisible();
  await scanBurst(page, AUGMENTIN_BOX);
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(augmentin).toContainText('3 Boxes');
  // Neither line got a discount.
  await expect(total).toContainText('Rs 4,166.00');
  await expect(page.getByText('Item discounts')).toBeHidden();

  // With the cursor on a button, a scan still adds the item and doesn't press the button.
  await page.getByRole('button', { name: /^Pay/ }).focus();
  await scanBurst(page, CALPOL_STRIP);
  await expect(calpol).toContainText('3 Strips');
  await expect(total).toContainText('Rs 4,286.00');
  await expect(page.getByRole('dialog')).toBeHidden();

  expect(problems).toEqual([]);
});

test('a scan while paying is ignored; a barcode typed into cash must be confirmed', async ({
  page,
}) => {
  const problems = await setUpTill(page);
  await createAugmentin(page);
  await openShift(page);
  const scan = page.getByLabel('Scan or search');
  await scanBurst(page, AUGMENTIN_BOX);
  await expect(page.getByRole('row', { name: /Augmentin 625mg/ })).toContainText('1 Box');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 1,309.00');

  await page.keyboard.press('F9');
  const pay = page.getByRole('dialog', { name: 'Pay' });
  const cash = pay.getByLabel('Cash received');
  await expect(cash).toBeFocused();

  // A burst into the cash box: nothing lands there, and its Enter doesn't complete the sale
  // (Enter on an empty cash box would mean exact cash).
  await scanBurst(page, AUGMENTIN_BOX);
  await expect(pay.getByText('Scan ignored — finish payment first (Esc)')).toBeVisible();
  await expect(cash).toHaveValue('');
  await expect(page.getByTestId('pay-total')).toHaveText('Rs 1,309.00');

  // Nor on the Complete button.
  await pay.getByRole('button', { name: 'Complete sale' }).focus();
  await scanBurst(page, AUGMENTIN_BOX);
  await expect(page.getByTestId('change-due')).toBeHidden();
  await expect(page.getByTestId('pay-total')).toHaveText('Rs 1,309.00');

  // Esc goes back to the sale, where the same scan adds the item.
  await page.keyboard.press('Escape');
  await expect(pay).toBeHidden();
  await expect(scan).toBeFocused();
  await scanBurst(page, AUGMENTIN_BOX);
  await expect(page.getByRole('row', { name: /Augmentin 625mg/ })).toContainText('2 Boxes');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 2,617.00');

  // Typed by hand into cash, a barcode is a huge tender that needs a second Enter.
  await page.keyboard.press('F9');
  await expect(cash).toBeFocused();
  await cash.pressSequentially(AUGMENTIN_BOX, { delay: BY_HAND });
  await expect(pay.getByText('looks like a typo')).toBeVisible();
  await cash.press('Enter');
  await expect(
    pay.getByText('Received Rs 8,961,234,567,890.00 for a Rs 2,617.00 bill? Enter to confirm'),
  ).toBeVisible();
  await expect(page.getByTestId('change-due')).toBeHidden();

  // Fixing the amount clears the question; the sale completes normally.
  await cash.fill('3000');
  await expect(pay.getByText('Enter to confirm')).toBeHidden();
  await cash.press('Enter');
  await expect(page.getByTestId('change-due')).toHaveText('Rs 383.00');

  expect(problems).toEqual([]);
});

test('past zero and expired stock on record warn but let the sale go on; an unknown barcode is reported', async ({
  page,
}) => {
  const problems = await setUpTill(page);
  // Augmentin: a strip in date and a strip long expired. Calpol: only an expired strip.
  await createAugmentin(page);
  await addBatch(page, 'AU0120', '01/2020', '6');
  await addBatch(page, 'AU1299', '12/2099', '6');
  await createCalpol(page);
  await addBatch(page, 'CP0120', '01/2020', '10');
  await openShift(page);
  const scan = page.getByLabel('Scan or search');

  // A barcode the till doesn't know is reported. The next scan replaces it in the scan box
  // rather than being typed onto the end of it.
  await scanBurst(page, '8960000000009');
  await expect(page.getByText('No item has the barcode 8960000000009')).toBeVisible();
  await scanBurst(page, CALPOL_STRIP);
  const calpol = page.getByRole('row', { name: /Calpol 5mg/ });
  await expect(calpol).toContainText('1 Strip');
  await expect(scan).toHaveValue('');
  await expect(page.getByText(/No item has the barcode/)).toBeHidden();

  // Selling past what is recorded, all of it expired: amber and red chips, no block.
  await expect(calpol).toContainText('Stock shows 0 Tablets — selling 1 Strip');
  await expect(calpol).toContainText('Expired stock on record');
  // Two strips of Augmentin with one in date on record.
  await scan.fill('2s*augm');
  await scan.press('Enter');
  const augmentin = page.getByRole('row', { name: /Augmentin 625mg/ });
  await expect(augmentin).toContainText('Stock shows 1 Strip — selling 2 Strips');
  await expect(augmentin).toContainText('Expired stock on record');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 992.00');

  // Pay asks once for both lines, all expired and some in date, before taking money.
  await page.keyboard.press('F9');
  const pay = page.getByRole('dialog', { name: 'Pay' });
  await expect(pay.getByRole('heading', { name: 'Check the packs are in date' })).toBeVisible();
  await expect(pay).toContainText(
    'Calpol 5mg: 0 Tablets in date on record; selling 1 Strip more. Expired on record: CP0120 (Jan 2020) 1 Strip.',
  );
  await expect(pay).toContainText(
    'Augmentin 625mg: 1 Strip in date on record; selling 1 Strip more. Expired on record: AU0120 (Jan 2020) 1 Strip.',
  );
  const inDate = pay.getByRole('button', { name: 'Yes, they are in date' });
  await expect(inDate).toBeFocused();
  // One Enter answers it; the cash box is next, and Enter takes exact cash.
  await page.keyboard.press('Enter');
  await expect(pay.getByLabel('Cash received')).toBeFocused();
  await expect(page.getByTestId('pay-total')).toHaveText('Rs 992.00');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Invoice T1-000001', { exact: true })).toBeVisible();
  expect(problems).toEqual([]);
});
