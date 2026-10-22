import { describe, expect, it } from 'vitest';
import { asRole, createTestApp, tabletInput } from '../test-helpers';
import {
  backupStatus,
  listBackupLog,
  runBackup,
  runManualBackup,
  type BackupCheck,
  type BackupPort,
} from './backup';
import { createProduct } from './catalog';

/** A backup folder in memory. `seq` is what the copy reports for its outbox. */
function fakePort(options: { seq: () => number; integrity?: string; fail?: string }) {
  const files = new Map<string, number>();
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
    async list() {
      return [...files.keys()].map((name) => ({ name, sizeBytes: 4096, modifiedMs: 0 }));
    },
    async remove(name) {
      files.delete(name);
    },
  };
  return { port, files };
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
    expect(result).toEqual({ ok: true, name: 'till-20261021-140000-auto.db', message: null });
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
