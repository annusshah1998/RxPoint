import { describe, expect, it } from 'vitest';
import { allocateForSale, allocationCost, applyParts, type SaleLot } from './allocation';

const today = '2026-10-21';
const lots: SaleLot[] = [
  { batchId: 'PN-00', expiryDate: '2026-09-30', qty: 10, placeholder: false },
  { batchId: 'PN-01', expiryDate: '2027-01-31', qty: 15, placeholder: false },
  { batchId: 'PN-02', expiryDate: '2027-06-30', qty: 30, placeholder: false },
];

describe('allocateForSale', () => {
  it('takes the batch that expires first', () => {
    expect(allocateForSale(lots, 20, { today })).toEqual({
      ok: true,
      parts: [
        { batchId: 'PN-01', qty: 15, pick: 'fefo', stockBefore: 15 },
        { batchId: 'PN-02', qty: 5, pick: 'fefo', stockBefore: 30 },
      ],
      shortfall: 0,
      expiredQty: 10,
      needsExpiryCheck: false,
    });
  });

  it('sends anything beyond recorded stock to the placeholder', () => {
    const r = allocateForSale(lots, 50, { today });
    expect(r.ok && r.parts.at(-1)).toEqual({
      batchId: null,
      qty: 5,
      pick: 'unrecorded',
      stockBefore: 0,
    });
    const withPlaceholder = [
      ...lots,
      { batchId: 'UNREC', expiryDate: null, qty: -3, placeholder: true },
    ];
    const r2 = allocateForSale(withPlaceholder, 50, { today });
    expect(r2.ok && r2.parts.at(-1)).toEqual({
      batchId: 'UNREC',
      qty: 5,
      pick: 'unrecorded',
      stockBefore: -3,
    });
  });

  it('never uses the placeholder while real stock lasts', () => {
    const withPlaceholder = [
      ...lots,
      { batchId: 'UNREC', expiryDate: null, qty: 100, placeholder: true },
    ];
    const r = allocateForSale(withPlaceholder, 40, { today });
    expect(r.ok && r.parts.map((p) => p.batchId)).toEqual(['PN-01', 'PN-02']);
  });

  it('honours a manual pick, even below zero', () => {
    expect(
      allocateForSale(lots, 40, { today, manual: [{ batchId: 'PN-02', qty: 40 }] }),
    ).toMatchObject({
      ok: true,
      parts: [{ batchId: 'PN-02', qty: 40, pick: 'manual', stockBefore: 30 }],
    });
  });

  it('refuses expired, unknown or mismatched manual picks', () => {
    expect(allocateForSale(lots, 5, { today, manual: [{ batchId: 'PN-00', qty: 5 }] })).toEqual({
      ok: false,
      error: 'expired',
      batchId: 'PN-00',
    });
    expect(allocateForSale(lots, 5, { today, manual: [{ batchId: 'X', qty: 5 }] })).toMatchObject({
      error: 'unknown_batch',
    });
    expect(
      allocateForSale(lots, 5, { today, manual: [{ batchId: 'PN-01', qty: 4 }] }),
    ).toMatchObject({
      error: 'manual_qty',
    });
  });

  it('asks for an expiry check when selling past in-date stock with expired stock on record', () => {
    // 5 in date, 20 expired, selling 10: the extra 5 may well be the expired packs.
    const mixed = [
      { batchId: 'OLD', expiryDate: '2026-09-30', qty: 20, placeholder: false },
      { batchId: 'NEW', expiryDate: '2027-06-30', qty: 5, placeholder: false },
    ];
    expect(allocateForSale(mixed, 10, { today })).toMatchObject({
      ok: true,
      shortfall: 5,
      expiredQty: 20,
      needsExpiryCheck: true,
    });
    // Within in-date stock there is nothing to check.
    expect(allocateForSale(mixed, 5, { today })).toMatchObject({ needsExpiryCheck: false });
  });

  it('flags a sale where only expired stock is on record', () => {
    const r = allocateForSale([lots[0]!], 10, { today });
    expect(r).toMatchObject({ ok: true, shortfall: 10, expiredQty: 10, needsExpiryCheck: true });
    expect(r.ok && r.parts).toEqual([
      { batchId: null, qty: 10, pick: 'unrecorded', stockBefore: 0 },
    ]);
  });

  it('sells on the expiry date itself', () => {
    const r = allocateForSale(
      [{ batchId: 'D', expiryDate: today, qty: 2, placeholder: false }],
      1,
      { today },
    );
    expect(r.ok && r.parts[0]!.batchId).toBe('D');
  });

  it('shares stock between two lines of the same product', () => {
    const first = allocateForSale(lots, 15, { today });
    const left = applyParts(lots, first.ok ? first.parts : []);
    const second = allocateForSale(left, 10, { today });
    expect(second.ok && second.parts).toEqual([
      { batchId: 'PN-02', qty: 10, pick: 'fefo', stockBefore: 30 },
    ]);
  });
});

describe('allocationCost', () => {
  it('costs from the batch, else the product', () => {
    expect(allocationCost(20, { cost: 62475, packQty: 30 }, null, false)).toEqual({
      cost: 41650,
      source: 'batch',
    });
    expect(
      allocationCost(20, { cost: null, packQty: 30 }, { amount: 60000, perQty: 30 }, true),
    ).toEqual({
      cost: 40000,
      source: 'product',
    });
    expect(allocationCost(20, { cost: null, packQty: 30 }, null, false)).toEqual({
      cost: null,
      source: 'unknown',
    });
  });
});
