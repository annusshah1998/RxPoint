import { divRound, percentOf, roundToStep, type Money } from './money';
import { priceForQty, type PackPrice } from './pricing';

/**
 * Pricing a sale. One function, `priceSale`, gives every total the screen shows and
 * the database stores, so the cashier sees exactly what is recorded.
 *
 * Order (ADR 0002): gross from the pack price (the only rounding of a price) → line
 * discount → bill discount split pro rata → tax extracted per line (prices include
 * tax) → one bill rounding.
 */

export type DiscountSpec = { kind: 'percent'; bp: number } | { kind: 'amount'; amount: Money };

export interface RoundingRule {
  /** 1 = no rounding, 100 = nearest rupee. */
  step: Money;
  mode: 'nearest' | 'down';
}

export class PricingError extends Error {
  constructor(
    readonly reason: 'discount_exceeds' | 'not_discountable' | 'invalid_discount',
    readonly lineKey?: string,
  ) {
    super(reason);
    this.name = 'PricingError';
  }
}

function assertDiscountSpec(spec: DiscountSpec, key?: string) {
  const ok =
    spec.kind === 'percent'
      ? Number.isInteger(spec.bp) && spec.bp >= 0 && spec.bp <= 10_000
      : Number.isSafeInteger(spec.amount) && spec.amount >= 0;
  if (!ok) throw new PricingError('invalid_discount', key);
}

/** The discount a spec gives on `gross`. A fixed amount larger than gross is an error. */
export function lineDiscountAmount(gross: Money, spec: DiscountSpec | null, key?: string): Money {
  if (!spec) return 0;
  assertDiscountSpec(spec, key);
  if (spec.kind === 'percent') return percentOf(gross, spec.bp);
  if (spec.amount > gross) throw new PricingError('discount_exceeds', key);
  return spec.amount;
}

/**
 * Splits `total` in proportion to `weights` so the parts add up exactly.
 * Each part is the floor of its exact share; the leftover paisa go to the largest
 * remainders (ties to the earlier line). Zero weights get nothing.
 */
export function allocateProRata(total: Money, weights: readonly Money[]): Money[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError('total must be >= 0');
  const sum = weights.reduce((s, w) => s + w, 0);
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new RangeError('weights must be whole and >= 0');
  }
  if (sum === 0) {
    if (total > 0) throw new RangeError('nothing to allocate to');
    return weights.map(() => 0);
  }
  // BigInt: total × weight can pass 2^53 on large bills.
  const T = BigInt(total);
  const S = BigInt(sum);
  const parts = weights.map((w) => Number((T * BigInt(w)) / S));
  let left = total - parts.reduce((s, p) => s + p, 0);
  const order = weights
    .map((w, i) => ({ i, remainder: (T * BigInt(w)) % S }))
    .filter((x) => weights[x.i]! > 0)
    .sort((a, b) => (a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1));
  for (const { i } of order) {
    if (left === 0) break;
    parts[i]! += 1;
    left -= 1;
  }
  return parts;
}

/** The tax inside a tax-inclusive amount: amount × rate ÷ (1 + rate). */
export function extractTax(inclusive: Money, rateBp: number): Money {
  if (rateBp === 0) return 0;
  return divRound(inclusive * rateBp, 10_000 + rateBp);
}

export function roundBill(amount: Money, rule: RoundingRule): { total: Money; rounding: Money } {
  if (rule.step <= 1) return { total: amount, rounding: 0 };
  const total =
    rule.mode === 'down' ? amount - (amount % rule.step) : roundToStep(amount, rule.step);
  return { total, rounding: total - amount };
}

export interface PricingLine {
  key: string;
  price: PackPrice;
  /** Base units. */
  qty: number;
  taxRateBp: number;
  allowDiscount: boolean;
  /** 'default' takes the store default %; 'none' gives no line discount. */
  discount: DiscountSpec | 'default' | 'none';
}

export interface PricedLine {
  key: string;
  gross: Money;
  lineDiscount: Money;
  /** Its part of the bill discount. */
  billShare: Money;
  net: Money;
  tax: Money;
  discountSource: 'none' | 'default' | 'manual';
  /** The percent given, when the line discount was a percent. */
  lineDiscountBp: number | null;
}

export interface PricedSale {
  lines: PricedLine[];
  grossTotal: Money;
  lineDiscountTotal: Money;
  billDiscount: Money;
  billDiscountBp: number | null;
  subtotal: Money;
  taxTotal: Money;
  rounding: Money;
  total: Money;
  taxByRate: { rateBp: number; tax: Money }[];
}

export function priceSale(
  lines: readonly PricingLine[],
  bill: DiscountSpec | null,
  settings: { defaultDiscountBp: number; rounding: RoundingRule },
): PricedSale {
  const first = lines.map((line) => {
    const gross = priceForQty(line.price, line.qty);
    let spec: DiscountSpec | null = null;
    let source: PricedLine['discountSource'] = 'none';
    if (line.discount === 'default') {
      if (line.allowDiscount && settings.defaultDiscountBp > 0) {
        spec = { kind: 'percent', bp: settings.defaultDiscountBp };
        source = 'default';
      }
    } else if (line.discount !== 'none') {
      if (!line.allowDiscount) throw new PricingError('not_discountable', line.key);
      spec = line.discount;
      source = 'manual';
    }
    const lineDiscount = lineDiscountAmount(gross, spec, line.key);
    return {
      line,
      gross,
      lineDiscount,
      source,
      lineDiscountBp: spec?.kind === 'percent' ? spec.bp : null,
      after: gross - lineDiscount,
    };
  });

  const weights = first.map((f) => (f.line.allowDiscount ? f.after : 0));
  const billBase = weights.reduce((s, w) => s + w, 0);
  let billDiscount = 0;
  if (bill) {
    assertDiscountSpec(bill);
    billDiscount = bill.kind === 'percent' ? percentOf(billBase, bill.bp) : bill.amount;
    if (billDiscount > billBase) throw new PricingError('discount_exceeds');
  }
  const shares = billDiscount > 0 ? allocateProRata(billDiscount, weights) : weights.map(() => 0);

  const priced: PricedLine[] = first.map((f, i) => {
    const net = f.after - shares[i]!;
    return {
      key: f.line.key,
      gross: f.gross,
      lineDiscount: f.lineDiscount,
      billShare: shares[i]!,
      net,
      tax: extractTax(net, f.line.taxRateBp),
      discountSource: f.source,
      lineDiscountBp: f.lineDiscountBp,
    };
  });

  const grossTotal = priced.reduce((s, l) => s + l.gross, 0);
  const lineDiscountTotal = priced.reduce((s, l) => s + l.lineDiscount, 0);
  const subtotal = priced.reduce((s, l) => s + l.net, 0);
  const { total, rounding } = roundBill(subtotal, settings.rounding);

  const byRate = new Map<number, Money>();
  first.forEach((f, i) => {
    const tax = priced[i]!.tax;
    if (f.line.taxRateBp > 0)
      byRate.set(f.line.taxRateBp, (byRate.get(f.line.taxRateBp) ?? 0) + tax);
  });

  return {
    lines: priced,
    grossTotal,
    lineDiscountTotal,
    billDiscount,
    billDiscountBp: bill?.kind === 'percent' ? bill.bp : null,
    subtotal,
    taxTotal: priced.reduce((s, l) => s + l.tax, 0),
    rounding,
    total,
    taxByRate: [...byRate.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rateBp, tax]) => ({ rateBp, tax })),
  };
}

// ---------------------------------------------------------------------------
// Discount caps
// ---------------------------------------------------------------------------

/** A role's cap, never below the store default (the default is always allowed). */
export function effectiveCapBp(roleCapBp: number, defaultDiscountBp: number): number {
  return Math.max(roleCapBp, defaultDiscountBp);
}

/**
 * Whether a line's total discount (line discount + bill share) is within `capBp` of its
 * gross. One paisa of slack absorbs the bill-share rounding: a 5% bill discount over
 * Rs 49.99 + Rs 50.01 gives shares of Rs 2.50 each, which is "5%" though 2.50 > 2.4995.
 */
export function discountWithinCap(discount: Money, gross: Money, capBp: number): boolean {
  return discount * 10_000 <= capBp * gross + 10_000;
}

/** The smallest cap (bp) that covers this discount, allowing the same one paisa of slack. */
export function discountNeedBp(discount: Money, gross: Money): number {
  if (gross <= 0) return discount > 0 ? 10_000 : 0;
  return Math.ceil((Math.max(0, discount - 1) * 10_000) / gross);
}

// ---------------------------------------------------------------------------
// MRP
// ---------------------------------------------------------------------------

/** The MRP of `qty` base units from a batch, or null if the batch has no MRP. */
export function allocationMrp(
  qty: number,
  batch: { mrp: Money | null; packQty: number },
): Money | null {
  return batch.mrp === null ? null : priceForQty({ amount: batch.mrp, perQty: batch.packQty }, qty);
}

/**
 * A line is above MRP when what the customer pays for it (its net) is more than the MRP
 * of the units it takes. Only allocations with a known MRP count: `known` is their
 * total MRP and quantity, and the net is scaled to that quantity (cross-multiplied).
 */
export function isAboveMrp(net: Money, qty: number, known: { mrp: Money; qty: number }): boolean {
  if (known.qty <= 0 || qty <= 0) return false;
  return net * known.qty > known.mrp * qty;
}
