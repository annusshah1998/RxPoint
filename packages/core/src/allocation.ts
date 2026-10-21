import type { IsoDate } from './dates';
import { allocateFefo, type StockLot } from './fefo';
import type { Money } from './money';
import { priceForQty, type PackPrice } from './pricing';

/** A batch as checkout sees it. The placeholder is the product's "Unrecorded stock" batch. */
export interface SaleLot extends StockLot {
  placeholder: boolean;
}

export interface SalePart {
  /** null: the placeholder batch, to be created if the product has none yet. */
  batchId: string | null;
  qty: number;
  pick: 'fefo' | 'manual' | 'unrecorded';
  /** Stock in the batch just before this part (0 for a placeholder not created yet). */
  stockBefore: number;
}

export type AllocationResult =
  | {
      ok: true;
      parts: SalePart[];
      /** Units sold beyond recorded stock (they go to the placeholder). */
      shortfall: number;
      /** Units on record only in expired batches. */
      expiredQty: number;
      /** All the units come from unrecorded stock while expired stock is on record. */
      expiredOnly: boolean;
    }
  | { ok: false; error: 'expired' | 'unknown_batch' | 'manual_qty'; batchId?: string };

/**
 * Picks the batches a sale line takes stock from.
 *
 * Automatic: first-expiry-first-out over the real batches (expired and empty ones
 * skipped). Whatever is left goes to the placeholder batch, so a real batch is never
 * driven below zero on a guess.
 *
 * Manual (the pharmacist read the batch off the pack): each pick must be an unexpired
 * batch of this product and the picks must add up to the quantity. A manual pick may
 * take a batch below zero.
 */
export function allocateForSale(
  lots: readonly SaleLot[],
  qty: number,
  options: { today: IsoDate; manual?: readonly { batchId: string; qty: number }[] | null },
): AllocationResult {
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new RangeError('qty must be positive');
  const placeholder = lots.find((l) => l.placeholder) ?? null;
  const real = lots.filter((l) => !l.placeholder);

  if (options.manual && options.manual.length > 0) {
    const parts: SalePart[] = [];
    let sum = 0;
    for (const pick of options.manual) {
      const lot = lots.find((l) => l.batchId === pick.batchId);
      if (!lot) return { ok: false, error: 'unknown_batch', batchId: pick.batchId };
      if (lot.expiryDate !== null && lot.expiryDate < options.today) {
        return { ok: false, error: 'expired', batchId: pick.batchId };
      }
      if (!Number.isSafeInteger(pick.qty) || pick.qty <= 0) {
        return { ok: false, error: 'manual_qty', batchId: pick.batchId };
      }
      parts.push({
        batchId: lot.batchId,
        qty: pick.qty,
        pick: lot.placeholder ? 'unrecorded' : 'manual',
        stockBefore: lot.qty,
      });
      sum += pick.qty;
    }
    if (sum !== qty) return { ok: false, error: 'manual_qty' };
    return { ok: true, parts, shortfall: 0, expiredQty: 0, expiredOnly: false };
  }

  const fefo = allocateFefo(real, qty, { today: options.today });
  const parts: SalePart[] = fefo.allocations.map((a) => ({
    batchId: a.batchId,
    qty: a.qty,
    pick: 'fefo',
    stockBefore: real.find((l) => l.batchId === a.batchId)!.qty,
  }));
  if (fefo.shortfall > 0) {
    parts.push({
      batchId: placeholder?.batchId ?? null,
      qty: fefo.shortfall,
      pick: 'unrecorded',
      stockBefore: placeholder?.qty ?? 0,
    });
  }
  return {
    ok: true,
    parts,
    shortfall: fefo.shortfall,
    expiredQty: fefo.expiredQty,
    expiredOnly: fefo.shortfall === qty && fefo.expiredQty > 0,
  };
}

/**
 * Takes allocated parts out of a working copy of the lots, so two lines of the same
 * product in one sale don't both count the same stock.
 */
export function applyParts(lots: readonly SaleLot[], parts: readonly SalePart[]): SaleLot[] {
  return lots.map((lot) => {
    const used = parts
      .filter((p) => p.batchId === lot.batchId || (p.batchId === null && lot.placeholder))
      .reduce((sum, p) => sum + p.qty, 0);
    return used ? { ...lot, qty: lot.qty - used } : lot;
  });
}

/**
 * Cost of `qty` units from a batch. Placeholder stock (and real batches without a
 * cost) use the product's usual cost when known.
 */
export function allocationCost(
  qty: number,
  batch: { cost: Money | null; packQty: number },
  productCost: PackPrice | null,
  placeholder: boolean,
): { cost: Money | null; source: 'batch' | 'product' | 'unknown' } {
  if (!placeholder && batch.cost !== null) {
    return {
      cost: priceForQty({ amount: batch.cost, perQty: batch.packQty }, qty),
      source: 'batch',
    };
  }
  if (productCost) return { cost: priceForQty(productCost, qty), source: 'product' };
  return { cost: null, source: 'unknown' };
}
