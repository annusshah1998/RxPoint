import { localDate, type IsoDate } from './dates';

/**
 * Guards against a wrong PC clock (a dead CMOS battery, a mis-set date). Every document
 * write raises a "high water" timestamp. A clock far behind it, or a date that can't be
 * right, blocks selling until someone fixes it; expiry checks never use a date earlier
 * than the high water, so moving the clock back can't make expired stock sellable.
 */
export type ClockStatus =
  | { status: 'ok' }
  | { status: 'behind'; severity: 'warn' | 'block'; byMs: number }
  | { status: 'ahead'; days: number }
  | { status: 'implausible' };

const DAY = 86_400_000;

export interface ClockLimits {
  /** When the app was built: a clock before this is certainly wrong. */
  buildTime: Date;
  warnBehindMs?: number;
  blockBehindMs?: number;
  /** A clock more than this many days ahead of the high water asks to confirm the date. */
  aheadDays?: number;
  latestYear?: number;
}

export function assessClock(now: Date, highWater: string | null, limits: ClockLimits): ClockStatus {
  const {
    warnBehindMs = 10 * 60_000,
    blockBehindMs = DAY,
    aheadDays = 3,
    latestYear = 2035,
  } = limits;
  const t = now.getTime();
  if (t < limits.buildTime.getTime() - DAY || now.getUTCFullYear() > latestYear) {
    return { status: 'implausible' };
  }
  if (!highWater) return { status: 'ok' };
  const hw = Date.parse(highWater);
  if (Number.isNaN(hw)) return { status: 'ok' };
  const behind = hw - t;
  if (behind > blockBehindMs) return { status: 'behind', severity: 'block', byMs: behind };
  if (behind > warnBehindMs) return { status: 'behind', severity: 'warn', byMs: behind };
  const ahead = t - hw;
  if (ahead > aheadDays * DAY) return { status: 'ahead', days: Math.floor(ahead / DAY) };
  return { status: 'ok' };
}

/** The business date: today in the store's time zone, but never before the high water's date. */
export function effectiveToday(now: Date, highWater: string | null, timeZone: string): IsoDate {
  const today = localDate(now, timeZone);
  if (!highWater) return today;
  const hw = new Date(highWater);
  if (Number.isNaN(hw.getTime())) return today;
  const hwDate = localDate(hw, timeZone);
  return hwDate > today ? hwDate : today;
}

/** The later of two ISO timestamps (for raising the high water). */
export function laterTimestamp(a: string | null, b: string): string {
  return a && a > b ? a : b;
}
