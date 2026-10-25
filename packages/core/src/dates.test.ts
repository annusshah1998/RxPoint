import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  expiryStatus,
  formatDate,
  formatExpiry,
  isIsoDate,
  localDate,
  localTime,
  parseExpiry,
} from './dates';

describe('parseExpiry', () => {
  it.each([
    ['2027-03-15', '2027-03-15'],
    ['2027/3/5', '2027-03-05'],
    ['2027-03', '2027-03-31'],
    ['03/2027', '2027-03-31'],
    ['3/27', '2027-03-31'],
    ['02-2028', '2028-02-29'],
    ['02/2027', '2027-02-28'],
    ['15/03/2027', '2027-03-15'],
    ['15.03.27', '2027-03-15'],
    ['MAR 2027', '2027-03-31'],
    ['mar-27', '2027-03-31'],
    ['MAR27', '2027-03-31'],
    ['March 2027', '2027-03-31'],
    ['  sep/2026 ', '2026-09-30'],
  ])('reads %s', (input, expected) => {
    expect(parseExpiry(input)).toBe(expected);
  });

  it.each(['', 'soon', '13/2027', '31/02/2027', '2027-13-01', 'foo 2027', '1/1/1999'])(
    'rejects %s',
    (input) => {
      expect(parseExpiry(input)).toBeNull();
    },
  );
});

describe('date helpers', () => {
  it('validates ISO dates', () => {
    expect(isIsoDate('2027-02-28')).toBe(true);
    expect(isIsoDate('2027-02-30')).toBe(false);
    expect(isIsoDate('27-02-28')).toBe(false);
  });

  it('counts days', () => {
    expect(daysBetween('2026-10-21', '2026-10-31')).toBe(10);
    expect(daysBetween('2026-10-21', '2026-10-01')).toBe(-20);
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('formats expiry dates like packs print them', () => {
    expect(formatExpiry('2027-03-31')).toBe('Mar 2027');
    expect(formatExpiry('2027-03-15')).toBe('15 Mar 2027');
  });

  it('formats a calendar date with the day always shown', () => {
    expect(formatDate('2009-01-01')).toBe('1 Jan 2009');
    expect(formatDate('2027-03-31')).toBe('31 Mar 2027');
    expect(formatDate('not a date')).toBe('not a date');
  });

  it('uses the store time zone for "today"', () => {
    // 20:00 UTC on 21 Oct is 01:00 on 22 Oct in Karachi (UTC+5).
    const at = new Date('2026-10-21T20:00:00Z');
    expect(localDate(at, 'Asia/Karachi')).toBe('2026-10-22');
    expect(localDate(at, 'UTC')).toBe('2026-10-21');
    expect(localTime(at, 'Asia/Karachi')).toBe('01:00');
    expect(localTime(new Date('2026-10-21T09:10:00Z'), 'Asia/Karachi')).toBe('14:10');
  });
});

describe('expiryStatus', () => {
  const today = '2026-10-21';
  it('classifies batches', () => {
    expect(expiryStatus(null, today, 90)).toBe('none');
    expect(expiryStatus('2026-10-20', today, 90)).toBe('expired');
    expect(expiryStatus('2026-10-21', today, 90)).toBe('near'); // last day it can be sold
    expect(expiryStatus('2027-01-19', today, 90)).toBe('near');
    expect(expiryStatus('2027-01-20', today, 90)).toBe('ok');
  });
});
