import type { IsoDate } from './dates';

/** Stock available in one batch, in base units. */
export interface StockLot {
  batchId: string;
  expiryDate: IsoDate | null;
  qty: number;
  /** When the batch was received; breaks ties between batches with the same expiry. */
  receivedAt?: string;
}

export interface FefoAllocation {
  batchId: string;
  qty: number;
}

export interface FefoResult {
  allocations: FefoAllocation[];
  /** Base units that could not be covered by sellable stock. */
  shortfall: number;
  /** Base units sitting in expired batches that were skipped. */
  expiredQty: number;
}

/**
 * First-expiry, first-out: takes stock from the batch that expires soonest.
 * Expired batches are skipped (unless `allowExpired`, e.g. for supplier returns),
 * batches without an expiry date go last.
 * When stock runs short the caller decides what to do with `shortfall`
 * (checkout warns and sells anyway, so sales never stop).
 */
export function allocateFefo(
  lots: readonly StockLot[],
  qtyNeeded: number,
  options: { today: IsoDate; allowExpired?: boolean },
): FefoResult {
  if (!Number.isSafeInteger(qtyNeeded) || qtyNeeded <= 0) {
    throw new RangeError('qtyNeeded must be a positive whole number');
  }
  const { today, allowExpired = false } = options;

  let expiredQty = 0;
  const usable = lots.filter((lot) => {
    if (lot.qty <= 0) return false;
    const expired = lot.expiryDate !== null && lot.expiryDate < today;
    if (expired && !allowExpired) {
      expiredQty += lot.qty;
      return false;
    }
    return true;
  });

  usable.sort((a, b) => {
    if (a.expiryDate !== b.expiryDate) {
      if (a.expiryDate === null) return 1;
      if (b.expiryDate === null) return -1;
      return a.expiryDate < b.expiryDate ? -1 : 1;
    }
    const ra = a.receivedAt ?? '';
    const rb = b.receivedAt ?? '';
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
  });

  const allocations: FefoAllocation[] = [];
  let remaining = qtyNeeded;
  for (const lot of usable) {
    if (remaining === 0) break;
    const take = Math.min(lot.qty, remaining);
    allocations.push({ batchId: lot.batchId, qty: take });
    remaining -= take;
  }

  return { allocations, shortfall: remaining, expiredQty };
}
