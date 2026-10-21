import { describe, expect, it } from 'vitest';
import { allocateFefo, type StockLot } from './fefo';

const today = '2026-10-21';

const lots: StockLot[] = [
  { batchId: 'late', expiryDate: '2028-01-31', qty: 50 },
  { batchId: 'soon', expiryDate: '2026-12-31', qty: 8 },
  { batchId: 'expired', expiryDate: '2026-09-30', qty: 20 },
  { batchId: 'no-expiry', expiryDate: null, qty: 100 },
  { batchId: 'empty', expiryDate: '2026-11-30', qty: 0 },
];

describe('allocateFefo', () => {
  it('takes from the batch that expires first', () => {
    expect(allocateFefo(lots, 5, { today })).toEqual({
      allocations: [{ batchId: 'soon', qty: 5 }],
      shortfall: 0,
      expiredQty: 20,
    });
  });

  it('spills over into later batches, leaving undated stock for last', () => {
    expect(allocateFefo(lots, 70, { today }).allocations).toEqual([
      { batchId: 'soon', qty: 8 },
      { batchId: 'late', qty: 50 },
      { batchId: 'no-expiry', qty: 12 },
    ]);
  });

  it('reports a shortfall instead of failing', () => {
    const result = allocateFefo(lots, 200, { today });
    expect(result.shortfall).toBe(42);
    expect(result.allocations.reduce((sum, a) => sum + a.qty, 0)).toBe(158);
  });

  it('can include expired stock when asked', () => {
    expect(allocateFefo(lots, 25, { today, allowExpired: true }).allocations).toEqual([
      { batchId: 'expired', qty: 20 },
      { batchId: 'soon', qty: 5 },
    ]);
  });

  it('still sells on the expiry date itself', () => {
    const result = allocateFefo([{ batchId: 'a', expiryDate: today, qty: 3 }], 1, { today });
    expect(result.allocations).toEqual([{ batchId: 'a', qty: 1 }]);
  });

  it('breaks ties by receive time', () => {
    const tied: StockLot[] = [
      { batchId: 'b', expiryDate: '2027-01-31', qty: 5, receivedAt: '2026-10-02T00:00:00Z' },
      { batchId: 'a', expiryDate: '2027-01-31', qty: 5, receivedAt: '2026-10-01T00:00:00Z' },
    ];
    expect(allocateFefo(tied, 6, { today }).allocations.map((a) => a.batchId)).toEqual(['a', 'b']);
  });

  it('rejects bad quantities', () => {
    expect(() => allocateFefo(lots, 0, { today })).toThrow();
    expect(() => allocateFefo(lots, 1.5, { today })).toThrow();
  });
});
