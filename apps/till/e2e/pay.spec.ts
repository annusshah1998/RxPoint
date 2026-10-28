import { expect, test } from '@playwright/test';
import { OWNER_PIN, addStaff, createAugmentin, openShift, setUpTill, switchUser } from './helpers';

test('a free item approved by PIN: Enter finishes the zero bill', async ({ page }) => {
  const problems = await setUpTill(page);
  await createAugmentin(page);
  await page.getByLabel('Batch no.').fill('AU1123');
  await page.getByLabel('Expiry').fill('03/2027');
  await page.getByLabel('Quantity').fill('2b');
  await page.getByRole('button', { name: 'Add stock' }).click();
  await expect(page.getByText('Stock added')).toBeVisible();
  await addStaff(page, 'Sana', 'Cashier', '1470');
  await switchUser(page, 'Sana', '1470');
  await page.keyboard.press('Alt+5');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1' })).toBeVisible();
  await page.keyboard.press('Alt+1');

  // A cashier gives a box away: 100% off is above her 5%, so Pay asks for the owner's PIN.
  const scan = page.getByLabel('Scan or search');
  await scan.fill('8961234567890');
  await scan.press('Enter');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 1,309.00');
  await page.keyboard.press('F6');
  await page.keyboard.type('100');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sale-total')).toContainText('Rs 0.00');
  await page.keyboard.press('F9');
  const pin = page.getByLabel('Their PIN');
  await expect(pin).toBeFocused();
  await pin.fill(OWNER_PIN);
  await pin.press('Enter');

  // After the approval there is no cash box; Enter still finishes, as the dialog says.
  await expect(page.getByText('Nothing to pay — press Enter to finish')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete sale' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Invoice T1-000001', { exact: true })).toBeVisible();
  await expect(page.getByTestId('change-due')).toHaveText('Rs 0.00');
  expect(problems).toEqual([]);
});

test('typing a patient name or a Raast reference never answers "Prescription seen?"', async ({
  page,
}) => {
  const problems = await setUpTill(page);
  // Augmentin needs a prescription; Valium is controlled, so Pay asks for the patient too.
  await createAugmentin(page, { rx: true });
  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Brand name').fill('Valium');
  await page.getByLabel('Strength', { exact: true }).first().fill('5mg');
  await page.getByLabel('Generic (salt) 1').fill('Diazepam');
  await page.getByLabel('Sale price').fill('50');
  await page.getByLabel('Controlled drug').selectOption({ label: 'Schedule B' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: /^Valium/ })).toBeVisible();
  await openShift(page);

  const scan = page.getByLabel('Scan or search');
  await scan.fill('augm');
  await scan.press('Enter');
  await scan.fill('valium');
  await scan.press('Enter');
  await expect(page.getByRole('row', { name: /Valium 5mg/ })).toContainText('Controlled (B)');
  // No Valium on record: the batch is typed from the pack.
  await page.keyboard.press('F4');
  await page.getByLabel('Batch no. on the pack').fill('VX221');
  await page.getByLabel('Expiry on the pack').fill('12/2027');
  await page.getByRole('button', { name: 'Use this batch' }).click();
  // Rs 436.20 + Rs 50.00, rounded.
  await expect(page.getByTestId('sale-total')).toContainText('Rs 486.00');

  await page.keyboard.press('F9');
  const pay = page.getByRole('dialog', { name: 'Pay' });
  const seen = pay.getByRole('button', { name: 'Seen', exact: true });
  const notSeen = pay.getByRole('button', { name: 'Not seen', exact: true });
  await expect(pay.getByLabel('Cash received')).toBeFocused();
  await expect(seen).toHaveAttribute('aria-pressed', 'false');
  await expect(notSeen).toHaveAttribute('aria-pressed', 'false');

  // Alt+Y answers; a name full of Ys and Ns typed key by key doesn't change it.
  await page.keyboard.press('Alt+Y');
  await expect(seen).toHaveAttribute('aria-pressed', 'true');
  const patient = pay.getByLabel('Patient name');
  await patient.pressSequentially('Nadia Younas');
  await pay.getByLabel('Doctor').pressSequentially('Dr Yasmin Naz');
  await expect(patient).toHaveValue('Nadia Younas');
  await expect(seen).toHaveAttribute('aria-pressed', 'true');
  await expect(notSeen).toHaveAttribute('aria-pressed', 'false');

  // Alt+N changes the answer; a Raast transaction ID typed by hand doesn't.
  await page.keyboard.press('Alt+N');
  await expect(notSeen).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Alt+W');
  await pay.getByLabel('Wallet', { exact: true }).selectOption({ label: 'Raast' });
  const reference = pay.getByLabel('Transaction ID');
  await reference.pressSequentially('RAASTNY7Y2N', { delay: 60 });
  await expect(reference).toHaveValue('RAASTNY7Y2N');
  await expect(notSeen).toHaveAttribute('aria-pressed', 'true');
  await expect(seen).toHaveAttribute('aria-pressed', 'false');

  // Alt+Y again settles it; the sale records the prescription as seen.
  await page.keyboard.press('Alt+Y');
  await expect(seen).toHaveAttribute('aria-pressed', 'true');
  await pay.getByLabel('Money received — I checked the app or SMS').check();
  await reference.press('Enter');
  await expect(page.getByText('Invoice T1-000001', { exact: true })).toBeVisible();
  await expect(page.getByTestId('receipt-preview')).toContainText(
    'Rx: Nadia Younas - Dr Yasmin Naz',
  );
  await page.keyboard.press('Enter');
  await page.keyboard.press('Alt+5');
  await expect(page.getByRole('row', { name: /^Raast/ })).toContainText('Rs 486.00');
  await expect(
    page
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: 'Prescriptions not seen' }) })
      .getByRole('cell'),
  ).toHaveText('0');
  expect(problems).toEqual([]);
});
