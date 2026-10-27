import type { BackupCheck } from '@app/db';
import { describe, expect, it } from 'vitest';
import { backupWarnings, checkSummary } from './backup-view';

describe('backupWarnings', () => {
  it('shows a badge for each problem, and none when backups are fine', () => {
    expect(backupWarnings({ overdue: false, mirrorOverdue: false })).toEqual([]);
    expect(backupWarnings({ overdue: true, mirrorOverdue: false })).toEqual([
      { key: 'overdue', label: 'Backup overdue' },
    ]);
    expect(backupWarnings({ overdue: true, mirrorOverdue: true }).map((w) => w.label)).toEqual([
      'Backup overdue',
      'Backup drive not updated',
    ]);
  });
});

describe('checkSummary', () => {
  const check: BackupCheck = {
    name: 'till-20261021-140000-auto.db',
    sizeBytes: 4096,
    integrityOk: true,
    integrity: 'ok',
    migrations: ['0001-initial', '0002-checkout', '0003-backup-mirror'],
    saleCount: 1234,
    lastSaleAt: '2026-10-21T08:55:00.000Z',
    outboxSeq: 50,
  };

  it('says what a sound copy holds, in store time', () => {
    expect(checkSummary(check, 'Asia/Karachi')).toEqual({
      ok: true,
      label: 'Sound',
      detail: 'Opens and reads correctly: 1,234 sales, the last on 21 Oct 2026, 13:55.',
    });
    expect(checkSummary({ ...check, saleCount: 0, lastSaleAt: null }, 'Asia/Karachi').detail).toBe(
      'Opens and reads correctly; no sales yet.',
    );
    expect(checkSummary({ ...check, saleCount: 1 }, 'Asia/Karachi').detail).toMatch(/: 1 sale,/);
  });

  it('warns against restoring a damaged copy', () => {
    expect(
      checkSummary({ ...check, integrityOk: false, integrity: 'page 3 is corrupt' }, 'UTC'),
    ).toEqual({
      ok: false,
      label: 'Damaged',
      detail: 'Don’t restore from this copy: page 3 is corrupt',
    });
  });
});
