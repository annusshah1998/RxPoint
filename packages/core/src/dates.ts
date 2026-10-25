import { MARKET } from '@app/config';

/** A calendar date, 'YYYY-MM-DD'. Sorts correctly as text. */
export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_LABELS = MONTHS.map((m) => m[0]!.toUpperCase() + m.slice(1));

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function makeDate(year: number, month: number, day: number | 'end'): IsoDate | null {
  if (month < 1 || month > 12 || year < 2000 || year > 2099) return null;
  const last = daysInMonth(year, month);
  const d = day === 'end' ? last : day;
  if (d < 1 || d > last) return null;
  return `${year}-${pad(month)}-${pad(d)}`;
}

function fullYear(text: string): number {
  const n = Number(text);
  return text.length === 2 ? 2000 + n : n;
}

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  return makeDate(Number(match[1]), Number(match[2]), Number(match[3])) === value;
}

/**
 * Reads an expiry date the way it is printed on packs or typed by staff.
 * A month without a day ("03/2027", "MAR 27") means the end of that month.
 * Day-first order is assumed for full dates ("15/03/2027"), as used in Pakistan.
 */
export function parseExpiry(input: string): IsoDate | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  let m: RegExpExecArray | null;

  // 2027-03-15 or 2027/03/15
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text))) {
    return makeDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // 2027-03
  if ((m = /^(\d{4})[-/.](\d{1,2})$/.exec(text))) {
    return makeDate(Number(m[1]), Number(m[2]), 'end');
  }
  // 15/03/2027, 15-03-27
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(text))) {
    return makeDate(fullYear(m[3]!), Number(m[2]), Number(m[1]));
  }
  // 03/2027, 3/27
  if ((m = /^(\d{1,2})[-/.](\d{4}|\d{2})$/.exec(text))) {
    return makeDate(fullYear(m[2]!), Number(m[1]), 'end');
  }
  // MAR 2027, mar-27, MAR27, March 2027
  if ((m = /^([a-z]{3})[a-z]*[ ./-]?(\d{4}|\d{2})$/.exec(text))) {
    const month = MONTHS.indexOf(m[1]!) + 1;
    if (month === 0) return null;
    return makeDate(fullYear(m[2]!), month, 'end');
  }
  return null;
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type ExpiryStatus = 'none' | 'expired' | 'near' | 'ok';

/**
 * A batch can still be sold on its expiry date and is expired from the next day.
 * `nearDays` is the warning window.
 */
export function expiryStatus(
  expiry: IsoDate | null,
  today: IsoDate,
  nearDays: number,
): ExpiryStatus {
  if (!expiry) return 'none';
  const days = daysBetween(today, expiry);
  if (days < 0) return 'expired';
  if (days <= nearDays) return 'near';
  return 'ok';
}

/** "Mar 2027" for month-end dates (how packs print them), otherwise "15 Mar 2027". */
export function formatExpiry(date: IsoDate): string {
  const match = ISO_DATE.exec(date);
  if (!match) return date;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const label = `${MONTH_LABELS[month - 1]} ${year}`;
  return day === daysInMonth(year, month) ? label : `${day} ${label}`;
}

/** "1 Jan 2009": a calendar date with the day always shown (for clock and shift messages). */
export function formatDate(date: IsoDate): string {
  const match = ISO_DATE.exec(date);
  if (!match) return date;
  return `${Number(match[3])} ${MONTH_LABELS[Number(match[2]) - 1]} ${match[1]}`;
}

/** The clock time at `at` in the store's time zone, as 24-hour "HH:MM". */
export function localTime(at: Date, timeZone: string = MARKET.timeZone): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

/** The calendar date at `at` in the store's time zone. Expiry checks use this, not UTC. */
export function localDate(at: Date, timeZone: string = MARKET.timeZone): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
