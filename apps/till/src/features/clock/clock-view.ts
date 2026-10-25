import { formatDate, localDate, localTime } from '@app/core';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How far behind, rounded down to a unit staff can picture: minutes, then hours, then days. */
export function roughDuration(ms: number): { n: number; unit: 'minute' | 'hour' | 'day' } {
  if (ms < HOUR) return { n: Math.max(1, Math.floor(ms / MINUTE)), unit: 'minute' };
  if (ms < 2 * DAY) return { n: Math.floor(ms / HOUR), unit: 'hour' };
  return { n: Math.floor(ms / DAY), unit: 'day' };
}

/** "21 Oct 2026, 09:00" in the store's time zone. */
export function formatDateTime(at: Date | string, timeZone: string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return `${formatDate(localDate(d, timeZone))}, ${localTime(d, timeZone)}`;
}
