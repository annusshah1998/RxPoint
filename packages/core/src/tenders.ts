import type { Money } from './money';

export const WALLET_PROVIDERS = ['jazzcash', 'easypaisa', 'raast', 'other'] as const;
export type WalletProvider = (typeof WALLET_PROVIDERS)[number];
export type PaymentMethod = 'cash' | 'card' | 'wallet' | 'khata';

/** What the cashier enters at Pay. */
export type Tender =
  | { method: 'cash'; tendered: Money }
  | { method: 'card'; amount: Money; reference?: string | null }
  | { method: 'wallet'; provider: WalletProvider; amount: Money; reference: string }
  | { method: 'khata'; amount: Money };

/** One payment row as stored. Cash is the amount kept: tendered − change. */
export interface SettledPayment {
  method: PaymentMethod;
  amount: Money;
  tendered: Money | null;
  change: Money | null;
  provider: WalletProvider | null;
  reference: string | null;
}

export type TenderProblem =
  | 'short'
  | 'non_cash_over_total'
  | 'cash_not_needed'
  | 'wallet_reference'
  | 'zero_amount'
  | 'khata_unavailable';

export type SettleResult =
  | { ok: true; payments: SettledPayment[]; cashApplied: Money; change: Money }
  | { ok: false; problem: TenderProblem; index?: number; short?: Money };

export const MIN_WALLET_REFERENCE = 4;

/**
 * Works out the payment rows for a bill. Card and wallet amounts can't exceed the
 * total (only cash gives change). Several cash entries merge into one row.
 */
export function settleTenders(total: Money, tenders: readonly Tender[]): SettleResult {
  let nonCash = 0;
  let tendered = 0;
  let cashRows = 0;
  const nonCashPayments: SettledPayment[] = [];

  for (const [index, t] of tenders.entries()) {
    if (t.method === 'khata') return { ok: false, problem: 'khata_unavailable', index };
    if (t.method === 'cash') {
      if (!Number.isSafeInteger(t.tendered) || t.tendered <= 0) {
        return { ok: false, problem: 'zero_amount', index };
      }
      tendered += t.tendered;
      cashRows++;
      continue;
    }
    if (!Number.isSafeInteger(t.amount) || t.amount <= 0) {
      return { ok: false, problem: 'zero_amount', index };
    }
    const reference = t.reference?.trim() || null;
    if (t.method === 'wallet' && (reference?.length ?? 0) < MIN_WALLET_REFERENCE) {
      return { ok: false, problem: 'wallet_reference', index };
    }
    nonCash += t.amount;
    nonCashPayments.push({
      method: t.method,
      amount: t.amount,
      tendered: null,
      change: null,
      provider: t.method === 'wallet' ? t.provider : null,
      reference,
    });
  }

  if (nonCash > total) return { ok: false, problem: 'non_cash_over_total' };
  const cashDue = total - nonCash;
  if (cashDue === 0 && cashRows > 0) return { ok: false, problem: 'cash_not_needed' };
  if (tendered < cashDue) return { ok: false, problem: 'short', short: cashDue - tendered };

  const payments = [...nonCashPayments];
  if (cashDue > 0) {
    payments.unshift({
      method: 'cash',
      amount: cashDue,
      tendered,
      change: tendered - cashDue,
      provider: null,
      reference: null,
    });
  }
  return { ok: true, payments, cashApplied: cashDue, change: tendered - cashDue };
}

/** Quick cash buttons: exact, then the next Rs 100 / 500 / 1,000 / 5,000. */
export function suggestCash(due: Money): Money[] {
  if (due <= 0) return [];
  const up = (step: Money) => Math.ceil(due / step) * step;
  return [...new Set([due, up(10_000), up(50_000), up(100_000), up(500_000)])].sort(
    (a, b) => a - b,
  );
}

/** A tender far beyond the bill is probably a typo or a barcode typed into the cash box. */
export function isSuspiciousTender(due: Money, tendered: Money): boolean {
  return tendered > due + 500_000 || (due > 0 && tendered > 10 * due && tendered > due + 10_000);
}
