import { MARKET } from '@app/config';

/**
 * Money is always a whole number of minor units (paisa). Never a float.
 * Rs 245.67 is stored as 24567.
 */
export type Money = number;

export function isMoney(value: unknown): value is Money {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertMoney(value: number, label = 'amount'): asserts value is Money {
  if (!isMoney(value)) throw new RangeError(`${label} must be a whole number of minor units`);
}

/**
 * Integer division rounded to the nearest whole number, halves away from zero.
 * Used wherever money is split, e.g. one tablet out of a strip.
 */
export function divRound(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new RangeError('divRound needs safe integers');
  }
  if (denominator === 0) throw new RangeError('divRound by zero');
  const quotient = Math.trunc(numerator / denominator);
  const remainder = numerator - quotient * denominator;
  if (2 * Math.abs(remainder) >= Math.abs(denominator)) {
    return quotient + Math.sign(numerator) * Math.sign(denominator);
  }
  return quotient;
}

/** Rounds to the nearest multiple of `step` (e.g. 100 = nearest rupee), halves away from zero. */
export function roundToStep(value: Money, step: Money): Money {
  assertMoney(value);
  if (!Number.isSafeInteger(step) || step <= 0) throw new RangeError('step must be positive');
  return divRound(value, step) * step;
}

/** `basisPoints` of `value` (1% = 100 bp), rounded to the nearest minor unit. */
export function percentOf(value: Money, basisPoints: number): Money {
  assertMoney(value);
  return divRound(value * basisPoints, 10_000);
}

const MONEY_INPUT = /^(-)?(\d+)(?:\.(\d{0,2}))?$/;

/**
 * Parses what a person types ("245.67", "1,250", "Rs 99.5") into minor units.
 * Returns null for anything that isn't a plain amount with at most two decimals.
 * Parsing is done on the text, never via floats, so 0.1 + 0.2 problems can't happen.
 */
export function parseMoney(input: string): Money | null {
  const cleaned = input
    .trim()
    .replace(new RegExp(`^${MARKET.currencySymbol}\\.?\\s*`, 'i'), '')
    .replace(/,/g, '')
    .replace(/\s+/g, '');
  const match = MONEY_INPUT.exec(cleaned);
  if (!match) return null;
  const [, minus, whole, fraction = ''] = match;
  const minor = Number(whole) * MARKET.minorPerMajor + Number(fraction.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(minor)) return null;
  return minus ? -minor : minor;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "1234.50" — for editable inputs. */
export function toMajorString(value: Money): string {
  assertMoney(value);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const whole = Math.floor(abs / MARKET.minorPerMajor);
  const fraction = String(abs % MARKET.minorPerMajor).padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

/** "Rs 1,234.50" — for display. */
export function formatMoney(value: Money, options: { symbol?: boolean } = {}): string {
  assertMoney(value);
  const { symbol = true } = options;
  const sign = value < 0 ? '-' : '';
  const [whole = '0', fraction = '00'] = toMajorString(Math.abs(value)).split('.');
  const amount = `${groupThousands(whole)}.${fraction}`;
  return symbol ? `${sign}${MARKET.currencySymbol} ${amount}` : `${sign}${amount}`;
}
