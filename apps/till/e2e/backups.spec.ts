import { expect, test, type Page } from '@playwright/test';
import { OWNER_PIN, setUpTill } from './helpers';

// Backups are made by the desktop app (Rust copies the database file), so the browser
// preview has no backup files, no [Check] and no badges. Here it covers what needs no
// files: the backup drive folder setting and how the log shows each copy. Copying to the
// folder, a stick pulled out, the 3-day badge and the folder checks are covered by
// packages/db/src/services/backup.test.ts (fake port) and the Rust tests in backup.rs.

function backupsCard(page: Page) {
  return page
    .locator('section.card')
    .filter({ has: page.getByRole('heading', { name: 'Backups', exact: true }) });
}

async function logInAgain(page: Page) {
  await page.reload();
  await page.getByLabel('PIN for Annus').fill(OWNER_PIN);
  await page.getByLabel('PIN for Annus').press('Enter');
  await expect(page.getByRole('heading', { name: 'Sale' })).toBeVisible();
}

test('the owner sets a backup drive folder for this till', async ({ page }) => {
  const problems = await setUpTill(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  const card = backupsCard(page);
  const folder = card.getByLabel('Backup drive folder');
  await expect(card.getByText('folder checks and copies run in the desktop app')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Test folder' })).toBeDisabled();

  // Only a full path will do.
  await folder.fill('TillBackups');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(
    card.getByText('Type the folder’s full path, such as E:\\TillBackups'),
  ).toBeVisible();
  await expect(folder).toHaveAttribute('aria-invalid', 'true');

  await folder.fill('E:\\TillBackups');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Saved', { exact: true })).toBeVisible();
  await expect(folder).not.toHaveAttribute('aria-invalid', 'true');

  // Kept after a reload.
  await logInAgain(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(backupsCard(page).getByLabel('Backup drive folder')).toHaveValue('E:\\TillBackups');

  // The preview makes no backups, so it shows no Back up now and no badges.
  await page.getByRole('link', { name: 'Backups' }).click();
  await expect(page.getByText('Backups run in the desktop app.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back up now' })).toHaveCount(0);
  await expect(page.locator('.sidebar-alerts')).toHaveCount(0);

  // An empty box takes the folder off.
  await page.getByRole('link', { name: 'Settings' }).click();
  await backupsCard(page).getByLabel('Backup drive folder').fill('');
  await backupsCard(page).getByRole('button', { name: 'Save' }).click();
  await expect(backupsCard(page).getByText('Saved', { exact: true })).toBeVisible();
  await logInAgain(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(backupsCard(page).getByLabel('Backup drive folder')).toHaveValue('');
  expect(problems).toEqual([]);
});

test('the backup log shows which copies reached the backup drive', async ({ page }) => {
  const problems = await setUpTill(page);
  // Rows as the desktop app would log them, written through a second connection to the
  // preview's database (as full-day.spec reads it), then the page is reloaded.
  await page.evaluate(`(async () => {
    const { createBrowserExecutor } = await import('/src/platform/browser-executor.ts');
    const db = await createBrowserExecutor();
    const rows = [
      ['a', 'shift', 'till-20261020-210000-shift.db', 'ok', 'ok', null, null,
        '2026-10-20T16:00:00.000Z'],
      ['b', 'auto', 'till-20261021-090000-auto.db', 'ok', 'failed',
        'The backup drive E:\\\\ is not connected', null, '2026-10-21T04:00:00.000Z'],
      ['c', 'manual', 'till-20261021-100000-manual.db', 'failed', 'none', null, 'Disk full',
        '2026-10-21T05:00:00.000Z'],
    ];
    for (const [id, kind, file, status, mirror, mirrorError, error, at] of rows) {
      await db.execute(
        'INSERT INTO backup_log (id, kind, file_name, status, size_bytes, outbox_seq, ' +
          'mirror_status, mirror_error, error, started_at, finished_at) ' +
          'VALUES (?, ?, ?, ?, 2097152, 1, ?, ?, ?, ?, ?)',
        [id, kind, file, status, mirror, mirrorError, error, at, at],
      );
    }
  })()`);
  await logInAgain(page);
  await page.getByRole('link', { name: 'Backups' }).click();

  const rows = page.getByRole('row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText('21 Oct 2026, 10:00');
  await expect(rows.nth(1)).toContainText('Disk full');
  await expect(rows.nth(2)).toContainText('till-20261021-090000-auto.db');
  await expect(rows.nth(2).getByText('Not copied')).toBeVisible();
  await expect(rows.nth(2).locator('[title]')).toHaveAttribute(
    'title',
    'The backup drive E:\\ is not connected',
  );
  await expect(rows.nth(3)).toContainText('20 Oct 2026, 21:00');
  await expect(rows.nth(3).getByText('Copied')).toBeVisible();
  // [Check] opens the file, which only the desktop app can do.
  await expect(page.getByRole('columnheader', { name: 'Check' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Check / })).toHaveCount(0);
  expect(problems).toEqual([]);
});
