import { divRound, type Money } from './money';
import { sortUnitsLargestFirst, type UnitDef } from './units';

/**
 * A price as printed: `amount` for `perQty` base units.
 * Rs 245.67 per strip of 10 tablets is { amount: 24567, perQty: 10 }.
 * Keeping the pack price (instead of a per-tablet price) means no rounding is
 * stored; rounding happens once per sale line.
 */
export interface PackPrice {
  amount: Money;
  perQty: number;
}

/** Price of `qty` base units, rounded once to the nearest minor unit. */
export function priceForQty(price: PackPrice, qty: number): Money {
  if (!Number.isSafeInteger(qty)) throw new RangeError('qty must be a whole number');
  if (!Number.isSafeInteger(price.perQty) || price.perQty <= 0) {
    throw new RangeError('perQty must be a positive whole number');
  }
  return divRound(price.amount * qty, price.perQty);
}

/** The price of one of each unit, largest first. */
export function pricePerUnit<T extends UnitDef>(
  price: PackPrice,
  units: readonly T[],
): { unit: T; amount: Money }[] {
  return sortUnitsLargestFirst(units).map((unit) => ({
    unit,
    amount: priceForQty(price, unit.qty),
  }));
}

/**
 * Gross margin of `sale` over `cost` in basis points of the sale price (2500 = 25%).
 * Returns null when either price is missing or the sale price is zero.
 */
export function marginBasisPoints(sale: PackPrice | null, cost: PackPrice | null): number | null {
  if (!sale || !cost || sale.amount === 0) return null;
  // Scale both prices to the same quantity (sale.perQty × cost.perQty) so nothing is rounded early.
  const saleAmount = sale.amount * cost.perQty;
  const costAmount = cost.amount * sale.perQty;
  return divRound((saleAmount - costAmount) * 10_000, saleAmount);
}
