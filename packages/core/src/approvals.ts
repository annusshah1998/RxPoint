import type { Cart, CartLine } from './cart';
import { discountWithinCap } from './checkout';
import type { Money } from './money';

/**
 * PIN approvals on the sale being rung up. Each one records exactly what the approver saw
 * (its "scope"); if the line, the bill discount or the seller changes, it no longer covers
 * the sale and has to be asked for again.
 */
export type GrantKind = 'sale.discount' | 'sale.controlled' | 'sale.price_override';

export interface Grant {
  kind: GrantKind;
  /** The line approved; '' for the whole bill. */
  lineKey: string;
  scopeJson: string;
  /** For discounts: the discount approved, in basis points of the line. */
  approvedBp: number | null;
  /** Who was selling when it was approved. */
  requestedBy: string;
  approverId: string;
}

/** JSON with object keys sorted, so equal values always give the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function priced(line: CartLine) {
  return { productId: line.productId, qty: line.qty, price: line.price, discount: line.discount };
}

/** Exactly what an approval of `kind` on `lineKey` ('' = the bill) covers, as canonical JSON. */
export function grantScope(cart: Cart, kind: GrantKind, lineKey: string): string {
  const line = cart.lines.find((l) => l.key === lineKey);
  switch (kind) {
    case 'sale.discount':
      if (lineKey === '') {
        return canonicalJson({
          billDiscount: cart.billDiscount,
          lines: cart.lines.map((l) => ({ key: l.key, ...priced(l) })),
        });
      }
      return canonicalJson({ line: line ? priced(line) : null, billDiscount: cart.billDiscount });
    case 'sale.controlled':
      return canonicalJson({
        lines: cart.lines
          .filter((l) => l.rx === 'controlled')
          .map((l) => ({
            key: l.key,
            productId: l.productId,
            qty: l.qty,
            batches: l.batches,
            packBatch: l.packBatch,
          })),
        prescription: cart.prescription,
      });
    case 'sale.price_override':
      return canonicalJson({
        line: line
          ? {
              productId: line.productId,
              qty: line.qty,
              price: line.price,
              reason: line.priceReason,
            }
          : null,
      });
  }
}

/**
 * Whether a stored grant still covers the cart for `actorId`: same scope, same seller, and
 * for a discount, at most what was approved. One extra paisa is allowed because a line's
 * share of the bill discount can move by a paisa when other lines change.
 */
export function grantCovers(
  grant: Pick<Grant, 'kind' | 'lineKey' | 'scopeJson' | 'approvedBp' | 'requestedBy'>,
  cart: Cart,
  actorId: string,
  discount?: { discount: Money; gross: Money },
): boolean {
  if (grant.requestedBy !== actorId) return false;
  if (grant.scopeJson !== grantScope(cart, grant.kind, grant.lineKey)) return false;
  if (grant.kind !== 'sale.discount') return true;
  if (!discount || grant.approvedBp === null) return false;
  return discountWithinCap(Math.max(0, discount.discount - 1), discount.gross, grant.approvedBp);
}
