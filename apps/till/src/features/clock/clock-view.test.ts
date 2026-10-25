import { describe, expect, it } from 'vitest';
import { formatDateTime, roughDuration } from './clock-view';

describe('roughDuration', () => {
  it('uses minutes under an hour, hours under two days, then days', () => {
    expect(roughDuration(11 * 60_000)).toEqual({ n: 11, unit: 'minute' });
    expect(roughDuration(30_000)).toEqual({ n: 1, unit: 'minute' });
    expect(roughDuration(10.5 * 3_600_000)).toEqual({ n: 10, unit: 'hour' });
    expect(roughDuration(47 * 3_600_000)).toEqual({ n: 47, unit: 'hour' });
    expect(roughDuration(3.2 * 86_400_000)).toEqual({ n: 3, unit: 'day' });
  });
});

describe('formatDateTime', () => {
  it('shows the date and time in the store’s time zone', () => {
    // 19:30 UTC on the 21st is 00:30 on the 22nd in Karachi.
    expect(formatDateTime('2026-10-21T19:30:00Z', 'Asia/Karachi')).toBe('22 Oct 2026, 00:30');
    expect(formatDateTime(new Date('2009-01-01T04:00:00Z'), 'Asia/Karachi')).toBe(
      '1 Jan 2009, 09:00',
    );
  });
});
