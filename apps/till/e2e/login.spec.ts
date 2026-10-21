import { expect, test } from '@playwright/test';
import { OWNER_PIN, logIn, setUpTill } from './helpers';

test('staff log in with their own PIN; wrong PINs lock; the owner can recover', async ({
  page,
}) => {
  // Set up, noting the recovery code shown once.
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.goto('/');
  await page.getByLabel('Pharmacy name').fill('Shifa Pharmacy');
  await page.getByLabel('Owner name').fill('Annus');
  await page.getByLabel('Owner PIN').fill('1234');
  await page.getByLabel('Type the PIN again').fill('1234');
  await page.getByRole('button', { name: 'Start using the till' }).click();
  await expect(page.getByText('Use exactly 6 digits')).toBeVisible();
  await page.getByLabel('Owner PIN').fill(OWNER_PIN);
  await page.getByLabel('Type the PIN again').fill(OWNER_PIN);
  await page.getByRole('button', { name: 'Start using the till' }).click();
  const recoveryCode = await page.getByLabel('Recovery code').innerText();
  expect(recoveryCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await page.getByRole('button', { name: 'I have written it down' }).click();

  // The owner adds a cashier.
  await page.getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('button', { name: 'Add person' }).click();
  await page.getByLabel('Name').fill('Sana');
  await page.getByLabel('Role').selectOption({ label: 'Cashier' });
  await page.getByLabel('PIN', { exact: true }).fill('1470');
  await page.getByLabel('Type the PIN again').fill('1470');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Sana' })).toBeVisible();

  // Ctrl+L locks the till.
  await page.keyboard.press('Control+l');
  await expect(page.getByRole('heading', { name: 'Who is using the till?' })).toBeVisible();

  // A wrong PIN counts down; the right one gets in, without the owner-only menu.
  await logIn(page, 'Sana', '0000');
  await expect(page.getByText('Wrong PIN — 4 tries left')).toBeVisible();
  await page.getByLabel('PIN for Sana').fill('1470');
  await page.getByLabel('PIN for Sana').press('Enter');
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  await expect(page.getByText('Till T1 · Sana')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Staff' })).toHaveCount(0);

  // Five wrong PINs lock Sana out.
  await page.getByRole('button', { name: 'Lock' }).click();
  for (const left of ['4 tries', '3 tries', '2 tries', '1 try']) {
    await logIn(page, 'Sana', '0000');
    await expect(page.getByText(`Wrong PIN — ${left} left`)).toBeVisible();
  }
  await logIn(page, 'Sana', '0000');
  await expect(page.getByText(/Too many wrong PINs\. Try again at \d\d:\d\d\./)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Sana.*Locked/ })).toBeVisible();

  // The owner unlocks her.
  await logIn(page, 'Annus', OWNER_PIN);
  await page.getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('button', { name: 'Unlock' })).toHaveCount(0);

  // The owner forgets the PIN and uses the recovery code.
  await page.keyboard.press('Control+l');
  await page.getByRole('button', { name: 'Owner forgot the PIN?' }).click();
  await page.getByLabel('Recovery code').fill(recoveryCode.toLowerCase());
  await page.getByLabel('New PIN', { exact: true }).fill('864208');
  await page.getByLabel('Type the new PIN again').fill('864208');
  await page.getByRole('button', { name: 'Reset PIN' }).click();
  const newCode = await page.getByLabel('Recovery code').innerText();
  expect(newCode).not.toBe(recoveryCode);
  await page.getByRole('button', { name: 'I have written it down' }).click();
  await logIn(page, 'Annus', '864208');
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();

  expect(problems).toEqual([]);
});

test('a reload asks for the PIN again', async ({ page }) => {
  const problems = await setUpTill(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Who is using the till?' })).toBeVisible();
  // With only one person, they are already chosen.
  await page.getByLabel('PIN for Annus').fill(OWNER_PIN);
  await page.getByLabel('PIN for Annus').press('Enter');
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  expect(problems).toEqual([]);
});
