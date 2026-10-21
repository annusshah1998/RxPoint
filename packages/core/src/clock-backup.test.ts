import { describe, expect, it } from 'vitest';
import {
  backupFileName,
  isBackupDue,
  parseBackupFileName,
  selectBackupsToDelete,
} from './backup-rules';
import { assessClock, effectiveToday, laterTimestamp } from './clock';

const buildTime = new Date('2026-10-01T00:00:00Z');
const now = new Date('2026-10-21T09:00:00Z');

describe('assessClock', () => {
  it('is ok with no history or a clock close to it', () => {
    expect(assessClock(now, null, { buildTime })).toEqual({ status: 'ok' });
    expect(assessClock(now, '2026-10-21T08:55:00Z', { buildTime })).toEqual({ status: 'ok' });
    expect(assessClock(now, '2026-10-21T09:05:00Z', { buildTime })).toEqual({ status: 'ok' });
  });

  it('warns a few hours behind and blocks a day behind', () => {
    expect(assessClock(now, '2026-10-21T19:30:00Z', { buildTime })).toEqual({
      status: 'behind',
      severity: 'warn',
      byMs: 10.5 * 3_600_000,
    });
    expect(assessClock(now, '2026-10-23T09:00:00Z', { buildTime })).toMatchObject({
      status: 'behind',
      severity: 'block',
    });
  });

  it('asks to confirm a date far ahead, and rejects impossible dates', () => {
    expect(assessClock(now, '2026-10-10T09:00:00Z', { buildTime })).toEqual({
      status: 'ahead',
      days: 11,
    });
    expect(assessClock(new Date('2009-01-01T00:00:00Z'), null, { buildTime })).toEqual({
      status: 'implausible',
    });
    expect(assessClock(new Date('2041-01-01T00:00:00Z'), null, { buildTime })).toEqual({
      status: 'implausible',
    });
  });
});

describe('effectiveToday', () => {
  it('never goes before the high water date', () => {
    // High water is 00:30 on the 22nd in Karachi; the clock says the 21st.
    expect(effectiveToday(now, '2026-10-21T19:30:00Z', 'Asia/Karachi')).toBe('2026-10-22');
    expect(effectiveToday(now, '2026-10-20T10:00:00Z', 'Asia/Karachi')).toBe('2026-10-21');
    expect(effectiveToday(now, null, 'Asia/Karachi')).toBe('2026-10-21');
  });

  it('picks the later timestamp', () => {
    expect(laterTimestamp(null, '2026-10-21T00:00:00Z')).toBe('2026-10-21T00:00:00Z');
    expect(laterTimestamp('2026-10-22T00:00:00Z', '2026-10-21T00:00:00Z')).toBe(
      '2026-10-22T00:00:00Z',
    );
  });
});

describe('backup names', () => {
  it('uses store-local time and parses back', () => {
    const name = backupFileName(new Date('2026-10-21T09:05:00Z'), 'auto', 'Asia/Karachi');
    expect(name).toBe('till-20261021-140500-auto.db');
    expect(parseBackupFileName(name)).toEqual({
      name,
      stamp: '2026-10-21 14:05:00',
      day: '2026-10-21',
      month: '2026-10',
      kind: 'auto',
    });
    expect(parseBackupFileName('till.db')).toBeNull();
  });
});

describe('isBackupDue', () => {
  const at = (h: number) => new Date(Date.parse('2026-10-21T00:00:00Z') + h * 3_600_000);
  it('follows the schedule', () => {
    expect(isBackupDue({ okAt: null, outboxSeq: null }, at(0), 5)).toBe(true);
    const last = { okAt: at(0).toISOString(), outboxSeq: 10 };
    expect(isBackupDue(last, at(1), 50)).toBe(false); // under 2 h
    expect(isBackupDue(last, at(3), 10)).toBe(false); // no new data
    expect(isBackupDue(last, at(3), 11)).toBe(true);
    expect(isBackupDue(last, at(25), 10)).toBe(true); // a day old
    expect(isBackupDue(last, at(-5), 10)).toBe(false); // clock behind, nothing new
    expect(isBackupDue(last, at(-5), 11)).toBe(true); // clock behind, new data
  });
});

describe('selectBackupsToDelete', () => {
  // Hourly backups for 60 days ending 21 Oct 2026 23:00.
  const names: string[] = [];
  const end = Date.parse('2026-10-21T23:00:00Z');
  for (let h = 0; h < 60 * 24; h++) {
    const d = new Date(end - h * 3_600_000);
    names.push(backupFileName(d, 'auto', 'UTC'));
  }
  names.push('till-20260601-090000-premigrate.db', 'till-20260501-090000-premigrate.db');

  it('thins hourly backups to the agreed set', () => {
    const doomed = new Set(selectBackupsToDelete(names));
    const kept = names.filter((n) => !doomed.has(n));
    // 49 in the last 48 h (inclusive) + newest of 30 days (2 already counted) + months + 2 premigrate.
    const recent = kept.filter((n) => n >= 'till-20261019-230000');
    expect(recent).toHaveLength(49);
    const days = new Set(kept.map((n) => n.slice(5, 13)));
    expect(days.size).toBeGreaterThanOrEqual(30);
    expect(kept).toContain('till-20260601-090000-premigrate.db');
    expect(kept).toContain('till-20260501-090000-premigrate.db');
    expect(kept).toContain(names[0]); // newest
    expect(kept.length).toBeLessThan(110);
  });

  it('never deletes the only backup and ignores other files', () => {
    expect(selectBackupsToDelete(['till-20200101-000000-auto.db'])).toEqual([]);
    expect(selectBackupsToDelete(['notes.txt'])).toEqual([]);
  });

  it('does not depend on the current date', () => {
    expect(selectBackupsToDelete(names)).toEqual(selectBackupsToDelete([...names].reverse()));
  });
});
