import { expect, test, type Page } from '@playwright/test';
import { addStaff, createAugmentin, setUpTill, switchUser } from './helpers';

/**
 * Augmentin with two boxes of batch AU1123. The MRP printed on the batch (Rs 415.00 a
 * strip) is below the till's price (Rs 436.20), so a strip sells above MRP. Then a shift is
 * opened and the till is back on the Sale screen, all by keys.
 */
async function stockAndShift(page: Page) {
  await createAugmentin(page);
  await page.getByLabel('Batch no.').fill('AU1123');
  await page.getByLabel('Expiry').fill('03/2027');
  await page.getByLabel('Quantity').fill('2b');
  await page.getByLabel('MRP per Strip').fill('415.00');
  await page.getByRole('button', { name: 'Add stock' }).click();
  await expect(page.getByText('Stock added')).toBeVisible();

  await page.keyboard.press('Alt+5');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1' })).toBeVisible();
  await page.keyboard.press('Alt+1');
  await expect(page.getByLabel('Scan or search')).toBeFocused();
}

async function addStrip(page: Page) {
  const scan = page.getByLabel('Scan or search');
  await scan.fill('augm');
  await scan.press('Enter');
  await expect(page.getByRole('row', { name: /Augmentin 625mg/ })).toContainText('1 Strip');
}

test('browser keys never reach the browser; typing and editing keys still work', async ({
  page,
}) => {
  const problems = await setUpTill(page);
  const search = page.getByLabel('Search products');
  await search.focus();

  // Whether the page cancels the browser's own action for each key, sent to the search box.
  const cancelled = await page.evaluate(() => {
    const keys: Record<string, KeyboardEventInit> = {};
    for (let n = 2; n <= 12; n++) keys[`F${n}`] = { key: `F${n}`, code: `F${n}` };
    for (const l of 'FGHJPRSUDK') {
      keys[`Ctrl+${l}`] = { key: l.toLowerCase(), code: `Key${l}`, ctrlKey: true };
    }
    keys['Ctrl+Shift+R'] = { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true };
    keys['Ctrl+='] = { key: '=', code: 'Equal', ctrlKey: true };
    keys['Ctrl+-'] = { key: '-', code: 'Minus', ctrlKey: true };
    keys['Ctrl+0'] = { key: '0', code: 'Digit0', ctrlKey: true };
    keys['Ctrl+NumpadAdd'] = { key: '+', code: 'NumpadAdd', ctrlKey: true };
    keys['Alt+ArrowLeft'] = { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true };
    keys['Alt+ArrowRight'] = { key: 'ArrowRight', code: 'ArrowRight', altKey: true };
    keys['Ctrl+Shift+Delete'] = { key: 'Delete', code: 'Delete', ctrlKey: true, shiftKey: true };
    // Typing and editing keys must go through.
    keys.a = { key: 'a', code: 'KeyA' };
    keys['Ctrl+A'] = { key: 'a', code: 'KeyA', ctrlKey: true };
    keys['Ctrl+C'] = { key: 'c', code: 'KeyC', ctrlKey: true };
    keys['Ctrl+V'] = { key: 'v', code: 'KeyV', ctrlKey: true };
    keys['Ctrl+X'] = { key: 'x', code: 'KeyX', ctrlKey: true };
    keys['Ctrl+Z'] = { key: 'z', code: 'KeyZ', ctrlKey: true };
    keys.Backspace = { key: 'Backspace', code: 'Backspace' };
    keys.Delete = { key: 'Delete', code: 'Delete' };
    keys.ArrowLeft = { key: 'ArrowLeft', code: 'ArrowLeft' };
    const target = document.activeElement!;
    const result: Record<string, boolean> = {};
    for (const [name, init] of Object.entries(keys)) {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      result[name] = !target.dispatchEvent(event);
    }
    return result;
  });
  const allowed = new Set(
    'a Ctrl+A Ctrl+C Ctrl+V Ctrl+X Ctrl+Z Backspace Delete ArrowLeft'.split(' '),
  );
  for (const [name, wasCancelled] of Object.entries(cancelled)) {
    expect(wasCancelled, name).toBe(!allowed.has(name));
  }

  // Real presses: typing, select-all and backspace work; F5 and Ctrl+R don't reload.
  await search.pressSequentially('Panadol');
  await search.press('Control+a');
  await search.pressSequentially('Augx');
  await search.press('Backspace');
  await expect(search).toHaveValue('Aug');
  await page.keyboard.press('F5');
  await page.keyboard.press('Control+r');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(search).toHaveValue('Aug');
  expect(problems).toEqual([]);
});

test('F1 lists the keys; over Pay, Esc closes only the list', async ({ page }) => {
  const problems = await setUpTill(page);
  await stockAndShift(page);

  await page.keyboard.press('F1');
  const help = page.getByRole('dialog', { name: 'Keyboard keys' });
  await expect(help).toBeVisible();
  await expect(help.getByRole('row', { name: /Alt\+M/ })).toContainText(
    'Sell the selected line at its MRP',
  );
  await expect(help.getByRole('row', { name: /Ctrl\+Shift\+Delete/ })).toContainText(
    'Clear the sale',
  );
  await expect(help.getByRole('row', { name: /Alt\+K/ })).toContainText('Add a card payment');
  // The owner may open every screen, Settings included.
  await expect(help.getByRole('row', { name: /Alt\+9/ })).toContainText('Go to Settings');
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(page.getByLabel('Scan or search')).toBeFocused();

  // The Keys button opens it too; F1 again closes it.
  await page.getByRole('button', { name: 'Keys' }).click();
  await expect(help).toBeVisible();
  await page.keyboard.press('F1');
  await expect(help).toBeHidden();

  // F1 in the middle of paying: Esc closes the list, Pay stays with the cursor in Cash.
  await addStrip(page);
  await page.keyboard.press('F9');
  const pay = page.getByRole('dialog', { name: 'Pay' });
  await expect(page.getByLabel('Cash received')).toBeFocused();
  await page.keyboard.press('F1');
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(pay).toBeVisible();
  await expect(page.getByLabel('Cash received')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pay).toBeHidden();
  expect(problems).toEqual([]);
});

test('Alt+1–5 and Alt+9 switch screens, only to those the role may open', async ({ page }) => {
  const problems = await setUpTill(page);
  await addStaff(page, 'Sana', 'Cashier', '1470');
  await addStaff(page, 'Kamran', 'Inventory clerk', '3690');

  const heading = (name: string) => page.getByRole('heading', { name, exact: true });
  await page.keyboard.press('Alt+3');
  await expect(heading('Products')).toBeVisible();
  await page.keyboard.press('Alt+4');
  await expect(heading('Stock & expiry')).toBeVisible();
  await page.keyboard.press('Alt+2');
  await expect(heading('Sales')).toBeVisible();
  await page.keyboard.press('Alt+5');
  await expect(heading('No shift is open')).toBeVisible();
  await page.keyboard.press('Alt+9');
  await expect(heading('Settings')).toBeVisible();
  await page.keyboard.press('Alt+1');
  await expect(heading('Sale')).toBeVisible();
  // The sidebar shows the keys; the links keep their plain names.
  await expect(page.getByRole('link', { name: 'Stock & expiry', exact: true })).toContainText(
    'Alt+4',
  );

  // A screen key waits while a dialog is open.
  await page.keyboard.press('F1');
  await expect(page.getByRole('dialog', { name: 'Keyboard keys' })).toBeVisible();
  await page.keyboard.press('Alt+3');
  await expect(page).toHaveURL(/#\/sale$/);
  await page.keyboard.press('Escape');

  // A cashier has no Settings: Alt+9 does nothing, and F1 doesn't offer it.
  await switchUser(page, 'Sana', '1470');
  await expect(heading('Sale')).toBeVisible();
  await page.keyboard.press('Alt+9');
  await expect(page).not.toHaveURL(/settings/);
  await page.keyboard.press('Alt+3');
  await expect(heading('Products')).toBeVisible();
  await page.keyboard.press('F1');
  const help = page.getByRole('dialog', { name: 'Keyboard keys' });
  await expect(help).toContainText('Go to Products');
  await expect(help).not.toContainText('Go to Settings');
  await page.keyboard.press('Escape');

  // An inventory clerk doesn't sell: Alt+1 and Alt+2 do nothing.
  await switchUser(page, 'Kamran', '3690');
  await page.keyboard.press('Alt+4');
  await expect(heading('Stock & expiry')).toBeVisible();
  await page.keyboard.press('Alt+1');
  await page.keyboard.press('Alt+2');
  await expect(page).toHaveURL(/#\/stock$/);
  await page.keyboard.press('Alt+3');
  await expect(heading('Products')).toBeVisible();
  expect(problems).toEqual([]);
});

test('Sale keys: Alt+M, Ctrl+P, Alt+C, Alt+D and Ctrl+Shift+Delete', async ({ page }) => {
  const problems = await setUpTill(page);
  await stockAndShift(page);
  const scan = page.getByLabel('Scan or search');
  const total = page.getByTestId('sale-total');

  // Ctrl+P before the first sale.
  await page.keyboard.press('Control+p');
  const reprint = page.getByRole('dialog', { name: 'Last receipt' });
  await expect(reprint).toContainText('No sale has been made on this till yet.');
  await page.keyboard.press('Escape');
  await expect(scan).toBeFocused();

  // Alt+M brings a line above MRP down to the batch MRP.
  await addStrip(page);
  await expect(page.getByText(/Above MRP by/)).toBeVisible();
  await expect(total).toContainText('Rs 436.00');
  await page.keyboard.press('Alt+m');
  await expect(total).toContainText('Rs 415.00');
  await expect(page.getByText(/Above MRP by/)).toBeHidden();
  await page.keyboard.press('Alt+m');
  await expect(page.getByText('The selected line is not above its MRP')).toBeVisible();

  // Exact cash, next sale; Ctrl+P shows that receipt again, marked as a reprint.
  await page.keyboard.press('F9');
  await expect(page.getByLabel('Cash received')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Invoice T1-000001', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(scan).toBeFocused();
  await page.keyboard.press('Control+p');
  await expect(reprint).toContainText('Invoice T1-000001');
  await expect(reprint.getByTestId('receipt-preview')).toContainText('*** REPRINT ***');
  await page.keyboard.press('Enter');
  await expect(reprint).toBeHidden();
  await expect(scan).toBeFocused();

  // Alt+C: cash in or out, starting on the amount.
  await page.keyboard.press('Alt+c');
  const cash = page.getByRole('dialog', { name: 'Cash in or out of the drawer' });
  await expect(cash.getByLabel('Amount')).toBeFocused();
  await page.keyboard.type('500');
  await cash.getByLabel('In or out').selectOption({ label: 'Cash in' });
  await cash.getByLabel('Note').fill('Change from the bank');
  await cash.getByLabel('Note').press('Enter');
  await expect(cash).toBeHidden();

  // Alt+D: open the drawer without a sale (the owner needs no approval).
  await page.keyboard.press('Alt+d');
  const noSale = page.getByRole('dialog', { name: 'Open the drawer without a sale' });
  await expect(noSale.getByLabel('Reason')).toBeFocused();
  await page.keyboard.type('Customer needed change');
  await page.keyboard.press('Enter');
  await expect(noSale).toBeHidden();

  // Ctrl+Shift+Delete asks first; Esc keeps the sale (Delete alone would remove the line).
  await addStrip(page);
  await page.keyboard.press('Control+Shift+Delete');
  const clear = page.getByRole('dialog', { name: 'Clear this sale?' });
  await expect(clear).toBeVisible();
  await expect(page.getByRole('row', { name: /Augmentin 625mg/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(clear).toBeHidden();
  await expect(page.getByRole('row', { name: /Augmentin 625mg/ })).toBeVisible();
  // Enter clears it. The button does the same.
  await page.keyboard.press('Control+Shift+Delete');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Scan an item or type its name to start.')).toBeVisible();
  await expect(scan).toBeFocused();
  await addStrip(page);
  await page.getByRole('button', { name: 'Clear sale' }).click();
  await clear.getByRole('button', { name: 'Clear sale' }).click();
  await expect(page.getByText('Scan an item or type its name to start.')).toBeVisible();

  // The cash-in shows on the shift.
  await page.keyboard.press('Alt+5');
  await expect(page.getByRole('row', { name: /Cash in/ })).toContainText('Rs 500.00');
  expect(problems).toEqual([]);
});

test('Pay: Alt+K adds a card row and Alt+W a wallet row', async ({ page }) => {
  const problems = await setUpTill(page);
  await stockAndShift(page);

  // Card for the whole bill: Alt+K fills in what is left and puts the cursor there.
  await addStrip(page);
  await page.keyboard.press('F9');
  await expect(page.getByLabel('Cash received')).toBeFocused();
  await page.keyboard.press('Alt+k');
  await expect(page.getByLabel('Card amount')).toBeFocused();
  await expect(page.getByLabel('Card amount')).toHaveValue('436.00');
  await expect(page.getByTestId('pay-balance')).toContainText('Rs 0.00');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Invoice T1-000001', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');

  // Wallet: Alt+W, pick the wallet, type the transaction ID, tick, Enter.
  await addStrip(page);
  await page.keyboard.press('F9');
  await expect(page.getByLabel('Cash received')).toBeFocused();
  await page.keyboard.press('Alt+w');
  const wallet = page.getByLabel('Wallet', { exact: true });
  await expect(wallet).toBeFocused();
  await wallet.selectOption({ label: 'Easypaisa' });
  await page.getByLabel('Transaction ID').fill('EP778899');
  await page.getByLabel('Money received — I checked the app or SMS').check();
  await page.getByLabel('Transaction ID').press('Enter');
  await expect(page.getByText('Invoice T1-000002', { exact: true })).toBeVisible();

  // Both appear on the shift report.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Alt+5');
  await expect(page.getByRole('row', { name: /^Card/ })).toContainText('Rs 436.00');
  await expect(page.getByRole('row', { name: /^Wallets/ })).toContainText('Rs 436.00');
  // Each wallet by the name the cashier picked, not its stored key.
  await expect(page.getByRole('row', { name: /^Easypaisa/ })).toContainText('Rs 436.00');
  expect(problems).toEqual([]);
});
