import { expect, test } from '@playwright/test';
import { OWNER_PIN, addStaff, logIn, setUpTill, switchUser } from './helpers';

// The browser's clock is faked: time keeps flowing from whatever it is set to.
// The dev server's start counts as the build time, so a date more than a day before it
// can't be right; every other date used here is now or later.
const DAY = 86_400_000;

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

test('a date that can’t be right blocks the till until Windows is fixed', async ({ page }) => {
  const problems = await setUpTill(page);

  // A dead CMOS battery: the PC starts up in 2009.
  await page.clock.setSystemTime(new Date('2009-01-01T09:00:00+05:00'));
  await page.reload();
  await logIn(page, 'Annus', OWNER_PIN);
  await expect(page.getByRole('heading', { name: 'The computer’s date is wrong' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(
    'The computer’s date (1 Jan 2009) can’t be right. Ask the owner to set the date and time in Windows (Settings → Time & language → Date & time).',
  );
  await expect(page.getByRole('link', { name: 'Sale', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('heading', { name: 'The computer’s date is wrong' })).toBeVisible();

  // The owner sets the date in Windows: the block lifts by itself.
  await page.clock.setSystemTime(Date.now());
  await expect(page.getByRole('heading', { name: 'Sale' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('link', { name: 'Sale', exact: true })).toBeVisible();
  expect(problems).toEqual([]);
});

test('a clock behind the last record warns, and a pharmacist’s PIN resets it', async ({ page }) => {
  const problems = await setUpTill(page);
  await addStaff(page, 'Sana', 'Cashier', '1470');
  await addStaff(page, 'Hina', 'Pharmacist', '2580');

  // The clock ran a day fast while the shift was opened...
  await page.clock.setSystemTime(Date.now() + DAY);
  await page.getByRole('link', { name: 'Shift' }).click();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1' })).toBeVisible();

  // ...then someone put it right. The next person to log in sees the warning.
  await page.clock.setSystemTime(Date.now());
  await switchUser(page, 'Sana', '1470');
  const banner = page.locator('.clock-banner');
  await expect(banner).toContainText(/The clock is \d+ hours behind the last record\./);
  await expect(banner).toContainText('You can keep selling.');

  // Selling goes on; the shift notes that records were made while the clock was behind.
  await expect(page.getByLabel('Scan or search')).toBeVisible();
  await page.getByRole('link', { name: 'Shift' }).click();
  await page.getByRole('button', { name: 'Cash in' }).click();
  await page.getByLabel('Amount').fill('100');
  await page.getByLabel('Note').fill('Change from bank');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByRole('row', { name: /Clock behind the last record/ })).toContainText(
    'Yes',
  );

  // The PC clock is right, so the check is reset. A cashier needs a pharmacist's PIN.
  await banner.getByRole('button', { name: 'The clock is right — reset' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reset the clock check' });
  await expect(dialog).toContainText('Until then, expiry is checked as if today were');
  await expect(dialog).toContainText('This needs a PIN from a pharmacist or the owner.');
  await dialog.getByLabel('Approved by').selectOption({ label: 'Hina' });
  await dialog.getByLabel('Their PIN').fill('9999');
  await dialog.getByRole('button', { name: 'Yes, the clock is right' }).click();
  await expect(dialog.getByText(/wrong PIN/i)).toBeVisible();
  await dialog.getByLabel('Their PIN').fill('2580');
  await dialog.getByLabel('Their PIN').press('Enter');
  await expect(dialog).toBeHidden();
  await expect(banner).toBeHidden();
  expect(problems).toEqual([]);
});

test('a clock days ahead asks to confirm the date when a shift opens', async ({ page }) => {
  const problems = await setUpTill(page);
  await page.getByRole('link', { name: 'Shift' }).click();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Close shift' }).click();
  await page.getByLabel('Rs 1,000 ×').fill('5');
  await page.getByLabel('Leave in the drawer for the next shift').fill('5000');
  await page.getByRole('dialog').getByRole('button', { name: 'Close shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1 closed' })).toBeVisible();

  // Four days later by the PC's clock (a holiday, or a clock set wrong).
  await page.clock.setSystemTime(Date.now() + 4 * DAY + 60_000);
  await page.getByRole('button', { name: 'Open next shift' }).click();
  await page.getByRole('button', { name: 'Open shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'Check the date' });
  await expect(dialog).toContainText(
    /Is today really \d{1,2} \w{3} \d{4}\? The last record was made 4 days earlier, on \d{1,2} \w{3} \d{4}\./,
  );
  await expect(dialog.getByRole('button', { name: /^Yes, today is/ })).toBeFocused();
  // One Enter confirms.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Shift 2' })).toBeVisible();
  expect(problems).toEqual([]);
});
