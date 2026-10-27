import { describe, expect, it } from 'vitest';
import { asRole, createTestApp, tabletInput } from '../test-helpers';
import {
  backupStatus,
  checkBackupFolder,
  listBackupLog,
  runBackup,
  runManualBackup,
  type BackupCheck,
  type BackupPort,
} from './backup';
import { createProduct } from './catalog';
import { getDeviceSettings, updateDeviceSettings } from './settings';

const USB = 'E:\\TillBackups';

/**
 * The till's backup folder in memory, plus mirror folders on "drives" that can be plugged
 * in and pulled out. `seq` is what the copy reports for its outbox.
 */
function fakePort(options: { seq: () => number; integrity?: string; fail?: string }) {
  const files = new Map<string, number>();
  const mirrors = new Map<string, Map<string, number>>();
  const plugged = new Set<string>();
  /** As backup.rs words it when the drive is missing. */
  const folder = (dir?: string) => {
    if (dir === undefined) return files;
    const found = mirrors.get(dir);
    if (!plugged.has(dir)) throw new Error(`The backup drive ${dir.slice(0, 3)} is not connected`);
    if (!found) throw new Error(`The folder ${dir} does not exist`);
    return found;
  };
  const usb = {
    plugIn(dir = USB) {
      plugged.add(dir);
    },
    pullOut(dir = USB) {
      plugged.delete(dir);
    },
    files(dir = USB) {
      return [...(mirrors.get(dir)?.keys() ?? [])].sort();
    },
  };
  const port: BackupPort = {
    async create(name) {
      if (options.fail) throw new Error(options.fail);
      files.set(name, 1000);
      const check: BackupCheck = {
        name,
        sizeBytes: 4096,
        integrityOk: (options.integrity ?? 'ok') === 'ok',
        integrity: options.integrity ?? 'ok',
        migrations: ['0001-initial', '0002-checkout'],
        saleCount: 0,
        lastSaleAt: null,
        outboxSeq: options.seq(),
      };
      return check;
    },
    async verify(name) {
      return port.create(name);
    },
    async list(dir) {
      return [...folder(dir).keys()].map((name) => ({ name, sizeBytes: 4096, modifiedMs: 0 }));
    },
    async remove(name, dir) {
      folder(dir).delete(name);
    },
    async copyTo(name, destDir) {
      const size = files.get(name);
      if (size === undefined) throw new Error(`Backup not found: ${name}`);
      folder(destDir).set(name, size);
    },
    async checkFolder(dir) {
      if (!plugged.has(dir))
        throw new Error(`The backup drive ${dir.slice(0, 3)} is not connected`);
      if (!mirrors.has(dir)) mirrors.set(dir, new Map());
    },
  };
  return { port, files, usb, mirrors };
}

async function outboxSeq(t: Awaited<ReturnType<typeof createTestApp>>) {
  const row = await t.db
    .selectFrom('sync_outbox')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .executeTakeFirst();
  return Number(row?.seq ?? 0);
}

describe('backups', () => {
  it('logs a good backup and knows when the next one is due', async () => {
    const t = await createTestApp();
    let seq = await outboxSeq(t);
    const { port, files } = fakePort({ seq: () => seq });
    expect((await backupStatus(t.ctx)).due).toBe(true);

    const result = await runBackup(t.ctx, port, 'auto');
    expect(result).toEqual({
      ok: true,
      name: 'till-20261021-140000-auto.db',
      message: null,
      mirror: 'none',
      mirrorMessage: null,
    });
    expect([...files.keys()]).toEqual(['till-20261021-140000-auto.db']);
    expect(await backupStatus(t.ctx)).toMatchObject({
      lastOk: { name: 'till-20261021-140000-auto.db' },
      overdue: false,
      due: false,
    });

    // Three hours later with new records, another is due.
    await createProduct(t.app, tabletInput());
    seq = await outboxSeq(t);
    t.setNow('2026-10-21T12:00:01Z');
    expect((await backupStatus(t.ctx)).due).toBe(true);
    // Two days without a backup is overdue.
    t.setNow('2026-10-23T12:00:01Z');
    expect((await backupStatus(t.ctx)).overdue).toBe(true);
  });

  it('marks a bad or out-of-date copy as failed, and never throws', async () => {
    const t = await createTestApp();
    const seq = await outboxSeq(t);
    expect(
      await runBackup(
        t.ctx,
        fakePort({ seq: () => seq, integrity: 'page 3 is corrupt' }).port,
        'auto',
      ),
    ).toMatchObject({ ok: false, message: 'The copy failed its check: page 3 is corrupt' });
    expect(await runBackup(t.ctx, fakePort({ seq: () => seq - 1 }).port, 'auto')).toMatchObject({
      ok: false,
      message: 'The copy is missing recent records',
    });
    expect(
      await runBackup(t.ctx, fakePort({ seq: () => seq, fail: 'Disk full' }).port, 'shift'),
    ).toMatchObject({
      ok: false,
      message: 'Disk full',
    });
    expect((await listBackupLog(t.ctx)).map((r) => r.ok)).toEqual([false, false, false]);
    expect((await backupStatus(t.ctx)).lastOk).toBeNull();
  });

  it('skips backups while the date is impossible, and thins old copies', async () => {
    const t = await createTestApp();
    const seq = await outboxSeq(t);
    const { port, files } = fakePort({ seq: () => seq });
    t.setNow('2009-01-01T00:00:00Z');
    expect(await runBackup(t.ctx, port, 'auto')).toMatchObject({ ok: false });
    expect(files.size).toBe(0);

    // Hourly copies over four days: older ones are thinned to one a day.
    for (let h = 0; h < 96; h++) {
      t.setNow(new Date(Date.parse('2026-10-18T00:00:00Z') + h * 3_600_000).toISOString());
      await runBackup(t.ctx, port, 'auto');
    }
    expect(files.size).toBeLessThan(60);
    expect(files.size).toBeGreaterThan(48);
  });

  it('lets cashiers back up by hand, but not inventory clerks', async () => {
    const t = await createTestApp();
    const seq = await outboxSeq(t);
    const cashier = await asRole(t, 'cashier');
    const clerk = await asRole(t, 'inventory');
    const { port } = fakePort({ seq: () => seq + 100 });
    expect(await runManualBackup(cashier.app, port)).toMatchObject({ ok: true });
    await expect(runManualBackup(clerk.app, port)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

/** An outbox number no copy falls behind (saving settings writes audit rows). */
const AHEAD = 1_000_000;

/** Hours after the test app's clock (21 Oct 2026, 14:00 in Karachi). */
const hoursLater = (h: number) =>
  new Date(Date.parse('2026-10-21T09:00:00Z') + h * 3_600_000).toISOString();

describe('the mirror folder (a USB stick or another drive)', () => {
  it('copies each good backup there and thins it by the same rule', async () => {
    const t = await createTestApp();
    const { port, files, usb, mirrors } = fakePort({ seq: () => AHEAD });
    usb.plugIn();
    await checkBackupFolder(t.app, port, USB);
    await updateDeviceSettings(t.app, { backup: { mirrorDir: USB } });
    // A file whose name the retention rule can't read is never deleted there.
    mirrors.get(USB)!.set('till-1-auto.db', 1);

    const first = await runBackup(t.ctx, port, 'auto');
    expect(first).toMatchObject({ ok: true, mirror: 'ok', mirrorMessage: null });
    expect(usb.files()).toEqual(['till-1-auto.db', first.name]);
    expect((await listBackupLog(t.ctx))[0]).toMatchObject({ mirror: 'ok', mirrorError: null });

    for (let h = 1; h < 96; h++) {
      t.setNow(hoursLater(h));
      await runBackup(t.ctx, port, 'auto');
    }
    const kept = [...files.keys()].sort();
    expect(kept.length).toBeLessThan(60);
    expect(kept.length).toBeGreaterThan(48);
    expect(usb.files()).toEqual([...kept, 'till-1-auto.db'].sort());
    expect((await backupStatus(t.ctx)).mirrorOverdue).toBe(false);
  });

  it('never fails the backup when the stick is pulled out, and warns after 3 days', async () => {
    const t = await createTestApp();
    const settings: { seq: () => number; fail?: string } = { seq: () => AHEAD };
    const { port, files, usb } = fakePort(settings);
    usb.plugIn();
    await checkBackupFolder(t.app, port, USB);
    await updateDeviceSettings(t.app, { backup: { mirrorDir: USB } });
    const copied = await runBackup(t.ctx, port, 'auto');
    expect(copied).toMatchObject({ ok: true, mirror: 'ok' });

    // Pulled out: the backup itself is fine, the copy is recorded as failed.
    usb.pullOut();
    t.setNow(hoursLater(3));
    const missed = await runBackup(t.ctx, port, 'shift');
    expect(missed).toMatchObject({
      ok: true,
      message: null,
      mirror: 'failed',
      mirrorMessage: 'The backup drive E:\\ is not connected',
    });
    expect(files.has(missed.name!)).toBe(true);
    expect(usb.files()).toEqual([copied.name]);
    expect((await listBackupLog(t.ctx))[0]).toMatchObject({
      ok: true,
      error: null,
      mirror: 'failed',
      mirrorError: 'The backup drive E:\\ is not connected',
    });
    expect(await backupStatus(t.ctx)).toMatchObject({
      overdue: false,
      mirrorOverdue: false,
      mirror: {
        dir: USB,
        lastCopyAt: '2026-10-21T09:00:00.000Z',
        lastError: 'The backup drive E:\\ is not connected',
      },
    });

    // A backup that fails doesn't try the stick at all.
    settings.fail = 'Disk full';
    expect(await runBackup(t.ctx, port, 'auto')).toMatchObject({ ok: false, mirror: 'none' });
    settings.fail = undefined;

    // Three days after the last copy, still out: the badge's warning.
    t.setNow(hoursLater(72));
    expect((await backupStatus(t.ctx)).mirrorOverdue).toBe(false);
    t.setNow(hoursLater(72.1));
    await runBackup(t.ctx, port, 'auto');
    expect(await backupStatus(t.ctx)).toMatchObject({ overdue: false, mirrorOverdue: true });

    // Plugged back in: the next backup catches up and the warning goes.
    usb.plugIn();
    t.setNow(hoursLater(75));
    expect(await runBackup(t.ctx, port, 'auto')).toMatchObject({ ok: true, mirror: 'ok' });
    expect(await backupStatus(t.ctx)).toMatchObject({
      mirrorOverdue: false,
      mirror: { lastCopyAt: hoursLater(75), lastError: null },
    });
  });

  it('counts the 3 days from the first try after a folder is set', async () => {
    const t = await createTestApp();
    const { port, usb } = fakePort({ seq: () => AHEAD });
    // Weeks of backups with no mirror folder.
    await runBackup(t.ctx, port, 'auto');
    t.setNow(hoursLater(500));
    await runBackup(t.ctx, port, 'auto');
    expect(await backupStatus(t.ctx)).toMatchObject({ mirror: null, mirrorOverdue: false });

    // A folder set while its drive is out: nothing is overdue before a copy was tried …
    await updateDeviceSettings(t.app, { backup: { mirrorDir: USB } });
    t.setNow(hoursLater(600));
    expect(await backupStatus(t.ctx)).toMatchObject({
      mirror: { dir: USB, lastCopyAt: null, lastError: null },
      mirrorOverdue: false,
    });
    // … and the first failed copy starts the 3 days.
    await runBackup(t.ctx, port, 'auto');
    t.setNow(hoursLater(671));
    await runBackup(t.ctx, port, 'auto');
    expect((await backupStatus(t.ctx)).mirrorOverdue).toBe(false);
    t.setNow(hoursLater(673));
    expect((await backupStatus(t.ctx)).mirrorOverdue).toBe(true);

    // Taking the folder off clears it.
    await updateDeviceSettings(t.app, { backup: { mirrorDir: '' } });
    expect((await getDeviceSettings(t.ctx)).backup.mirrorDir).toBeNull();
    expect(await backupStatus(t.ctx)).toMatchObject({ mirror: null, mirrorOverdue: false });

    // Set again later, with copies working: nothing old counts against it.
    usb.plugIn();
    await checkBackupFolder(t.app, port, USB);
    await runBackup(t.ctx, port, 'auto');
    await updateDeviceSettings(t.app, { backup: { mirrorDir: USB } });
    t.setNow(hoursLater(700));
    expect((await backupStatus(t.ctx)).mirrorOverdue).toBe(false);
  });

  it('checks the folder for the owner, with the problem on the field', async () => {
    const t = await createTestApp();
    const { port, usb } = fakePort({ seq: () => 0 });
    await expect(checkBackupFolder(t.app, port, USB)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      fields: { 'backup.mirrorDir': 'The backup drive E:\\ is not connected' },
    });
    usb.plugIn();
    await expect(checkBackupFolder(t.app, port, `  ${USB} `)).resolves.toBeUndefined();
    for (const typed of ['TillBackups', 'E:', '']) {
      await expect(checkBackupFolder(t.app, port, typed)).rejects.toMatchObject({
        code: 'VALIDATION',
        fields: { 'backup.mirrorDir': 'Type the folder’s full path, such as E:\\TillBackups' },
      });
    }
    const cashier = await asRole(t, 'cashier');
    await expect(checkBackupFolder(cashier.app, port, USB)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('saves only a full path, per till', async () => {
    const t = await createTestApp();
    await expect(
      updateDeviceSettings(t.app, { backup: { mirrorDir: 'TillBackups' } }),
    ).rejects.toMatchObject({ fields: { 'backup.mirrorDir': expect.any(String) } });
    for (const dir of ['D:\\Backups', 'e:/till', '\\\\nas\\share\\till', '/media/usb']) {
      const saved = await updateDeviceSettings(t.app, { backup: { mirrorDir: dir } });
      expect(saved.backup.mirrorDir).toBe(dir);
    }
    expect(
      (await updateDeviceSettings(t.app, { backup: { mirrorDir: '   ' } })).backup.mirrorDir,
    ).toBeNull();
  });
});
