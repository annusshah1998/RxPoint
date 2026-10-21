import type { Money } from './money';

/** What should be in the drawer: float + cash payments (signed) + pay-ins/outs (signed). */
export function expectedCash(
  openingFloat: Money,
  cashPayments: Money,
  cashMovements: Money,
): Money {
  return openingFloat + cashPayments + cashMovements;
}

/** Pakistani rupee notes, in paisa, largest first. */
export const PKR_NOTES = [500_000, 100_000, 50_000, 10_000, 5_000, 2_000, 1_000] as const;

export interface CashCount {
  /** Number of each note, keyed by its value in paisa. */
  notes: Record<string, number>;
  /** Coins counted as one amount. */
  coins: Money;
}

export function countTotal(count: CashCount): Money {
  let total = count.coins;
  for (const [value, n] of Object.entries(count.notes)) {
    const v = Number(value);
    if (!PKR_NOTES.includes(v as (typeof PKR_NOTES)[number])) {
      throw new RangeError(`not a note: ${value}`);
    }
    if (!Number.isInteger(n) || n < 0) throw new RangeError('note counts must be whole');
    total += v * n;
  }
  return total;
}
