import { roundBill, type RoundingRule } from './checkout';
import { divRound, type Money } from './money';

/**
 * The share of `total` (spread over `totalQty` units) for returning `qty` more units,
 * when `prevQty` units worth `prevAmount` were returned before. Using cumulative shares
 * means every return of the same line adds up exactly to the line's total.
 */
export function refundShare(
  total: Money,
  totalQty: number,
  prevQty: number,
  prevAmount: Money,
  qty: number,
): Money {
  if (qty <= 0 || prevQty + qty > totalQty) throw new RangeError('return quantity out of range');
  const share = divRound(total * (prevQty + qty), totalQty) - prevAmount;
  if (share < 0) throw new RangeError('refund share went negative');
  return share;
}

/**
 * The cash value of a return. The final return (everything now back) refunds exactly
 * what's left of the sale total. Otherwise rounding is cumulative, so the refunds of a
 * sale add up to what its rounded total would have been.
 */
export function refundTotal(args: {
  /** Net (before rounding) of earlier returns of this sale. */
  refundNetBefore: Money;
  refundNetNow: Money;
  isFinal: boolean;
  saleTotal: Money;
  /** Total refunded by earlier returns (after their rounding). */
  refundedBefore: Money;
  rule: RoundingRule;
}): { total: Money; rounding: Money } {
  if (args.isFinal) {
    const total = args.saleTotal - args.refundedBefore;
    return { total, rounding: total - args.refundNetNow };
  }
  const before = roundBill(args.refundNetBefore, args.rule).total;
  const after = roundBill(args.refundNetBefore + args.refundNetNow, args.rule).total;
  const total = after - before;
  return { total, rounding: total - args.refundNetNow };
}

/**
 * Which allocations a return comes out of: the most recently allocated batch first
 * (FEFO took the oldest first, so the newest pack is likely the one coming back).
 */
export function splitReturnQty(
  allocations: readonly { id: string; qty: number; returned: number }[],
  qty: number,
): { id: string; qty: number }[] {
  let left = qty;
  const out: { id: string; qty: number }[] = [];
  for (const a of [...allocations].reverse()) {
    if (left === 0) break;
    const take = Math.min(a.qty - a.returned, left);
    if (take > 0) {
      out.push({ id: a.id, qty: take });
      left -= take;
    }
  }
  if (left > 0) throw new RangeError('more returned than was sold');
  return out;
}
