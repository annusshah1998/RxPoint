import { describe, expect, it } from 'vitest';
import { createTestApp, openTestShift, tabletInput } from '../test-helpers';
import { createProduct } from './catalog';
import {
  addOpeningStock,
  adjustStock,
  findStockCacheMismatches,
  getProductStock,
  getStockSummary,
  listStock,
  planFefo,
  rebuildStockCache,
} from './stock';

// Test clock: 21 Oct 2026, 14:00 in Karachi.
async function withPanadol() {
  const t = await createTestApp();
  const product = await createProduct(t.app, tabletInput());
  return { ...t, product };
}

describe('addOpeningStock', () => {
  it('creates a batch and a ledger entry', async () => {
    const { app, db, product } = await withPanadol();
    const result = await addOpeningStock(app, {
      productId: product.id,
      batchNo: 'PN-01',
      expiryDate: '2027-06-30',
      qty: 45,
      costPrice: 62475,
      mrp: 73500,
    });
    expect(result.warnings).toEqual([]);

    const stock = await getProductStock(app, product.id);
    expect(stock.totalQty).toBe(45);
    expect(stock.batches).toMatchObject([
      {
        batchId: result.batchId,
        batchNo: 'PN-01',
        expiryDate: '2027-06-30',
        status: 'ok',
        qty: 45,
        packQty: 30, // defaults to the product's price unit
        costPrice: 62475,
        value: 93713, // 45 tablets at Rs 624.75 per 30 = Rs 937.125, rounded
      },
    ]);

    const movement = await db.selectFrom('stock_movement').selectAll().executeTakeFirstOrThrow();
    expect(movement).toMatchObject({ kind: 'opening', qty: 45, batch_id: result.batchId });
  });

  it('adds to the same batch when it is entered again', async () => {
    const { app, product } = await withPanadol();
    const line = { productId: product.id, batchNo: 'PN-01', expiryDate: '2027-06-30', qty: 10 };
    const a = await addOpeningStock(app, line);
    const b = await addOpeningStock(app, { ...line, batchNo: 'pn-01 ' });
    expect(b.batchId).toBe(a.batchId);
    expect((await getProductStock(app, product.id)).totalQty).toBe(20);
  });

  it('warns about missing details, expired stock and prices above MRP', async () => {
    const { app, product } = await withPanadol();
    expect(
      (await addOpeningStock(app, { productId: product.id, qty: 5, expiryDate: null })).warnings,
    ).toEqual(['No batch number entered', 'No expiry date entered']);
    expect(
      (
        await addOpeningStock(app, {
          productId: product.id,
          batchNo: 'OLD',
          expiryDate: '2026-09-30',
          qty: 5,
          mrp: 70000,
        })
      ).warnings,
    ).toEqual(['This batch has already expired', 'The sale price is higher than this batch’s MRP']);
  });

  it('rejects bad input', async () => {
    const { app, product } = await withPanadol();
    await expect(
      addOpeningStock(app, { productId: product.id, qty: 0, expiryDate: null }),
    ).rejects.toMatchObject({ code: 'VALIDATION', fields: { qty: expect.any(String) } });
    await expect(
      addOpeningStock(app, { productId: product.id, qty: 1, expiryDate: '2027-02-30' }),
    ).rejects.toMatchObject({ fields: { expiryDate: expect.any(String) } });
    await expect(
      addOpeningStock(app, { productId: 'missing', qty: 1, expiryDate: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('adjustStock', () => {
  it('changes stock with a reason and audits it', async () => {
    const { app, db, product } = await withPanadol();
    const { batchId } = await addOpeningStock(app, {
      productId: product.id,
      batchNo: 'A',
      expiryDate: '2027-06-30',
      qty: 30,
    });
    await adjustStock(app, { batchId, qtyDelta: -3, reason: 'Damaged strip' });
    expect((await getProductStock(app, product.id)).totalQty).toBe(27);
    const entry = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'stock.adjust')
      .executeTakeFirstOrThrow();
    expect(entry.reason).toBe('Damaged strip');
    expect(JSON.parse(entry.after_json!)).toEqual({ qty: 27 });
  });

  it('refuses to go below zero or without a reason', async () => {
    const { app, product } = await withPanadol();
    const { batchId } = await addOpeningStock(app, {
      productId: product.id,
      expiryDate: null,
      qty: 2,
    });
    await expect(adjustStock(app, { batchId, qtyDelta: -3, reason: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(adjustStock(app, { batchId, qtyDelta: 1, reason: ' ' })).rejects.toMatchObject({
      fields: { reason: expect.any(String) },
    });
  });
});

describe('batches and expiry', () => {
  async function stocked() {
    const t = await withPanadol();
    const add = (batchNo: string, expiryDate: string | null, qty: number, costPrice = 60000) =>
      addOpeningStock(t.app, { productId: t.product.id, batchNo, expiryDate, qty, costPrice });
    await add('LATE', '2028-01-31', 60);
    await add('SOON', '2026-12-31', 8);
    await add('GONE', '2026-09-30', 20);
    await add('NONE', null, 5, 0);
    return t;
  }

  it('lists batches soonest expiry first with their status', async () => {
    const { app, product } = await stocked();
    const stock = await getProductStock(app, product.id);
    expect(stock.batches.map((b) => [b.batchNo, b.status, b.daysToExpiry])).toEqual([
      ['GONE', 'expired', -21],
      ['SOON', 'near', 71],
      ['LATE', 'ok', 467],
      ['NONE', 'none', null],
    ]);
    expect(stock.totalQty).toBe(93);
    expect(stock.sellableQty).toBe(73);
  });

  it('plans a sale from the batch that expires first', async () => {
    const { app, product } = await stocked();
    const plan = await planFefo(app, product.id, 10);
    const stock = await getProductStock(app, product.id);
    const id = (no: string) => stock.batches.find((b) => b.batchNo === no)!.batchId;
    expect(plan).toEqual({
      allocations: [
        { batchId: id('SOON'), qty: 8 },
        { batchId: id('LATE'), qty: 2 },
      ],
      shortfall: 0,
      expiredQty: 20,
    });
  });

  it('filters the stock list', async () => {
    const { app } = await stocked();
    const batchNos = async (filter: 'in_stock' | 'near_expiry' | 'expired') =>
      (await listStock(app, { filter })).map((r) => r.batchNo);
    expect(await batchNos('in_stock')).toEqual(['GONE', 'SOON', 'LATE', 'NONE']);
    expect(await batchNos('near_expiry')).toEqual(['SOON']);
    expect(await batchNos('expired')).toEqual(['GONE']);
    expect((await listStock(app, { search: 'soo' })).map((r) => r.batchNo)).toEqual(['SOON']);
    expect((await listStock(app, { search: 'pana' })).length).toBe(4);
  });

  it('values stock and expiry risk at cost', async () => {
    const { app } = await stocked();
    // Rs 600 per box of 30 = Rs 20 per tablet.
    expect(await getStockSummary(app)).toEqual({
      stockValue: (60 + 8 + 20) * 2000,
      expiredValue: 20 * 2000,
      nearExpiryValue: 8 * 2000,
      expiredBatches: 1,
      nearExpiryBatches: 1,
      batchesWithoutCost: 0,
      productsInStock: 1,
    });
  });

  it('treats the store’s local date as today', async () => {
    const t = await stocked();
    // 19:30 UTC on 31 Dec is already 1 Jan in Karachi, so SOON has expired.
    t.setNow('2026-12-31T19:30:00Z');
    expect((await listStock(t.app, { filter: 'expired' })).map((r) => r.batchNo)).toEqual([
      'GONE',
      'SOON',
    ]);
  });

  it('checks expiry against the last record’s date when the clock is moved back', async () => {
    const t = await stocked();
    // A shift opened on 2 Jan 2027 raises the high water past SOON's expiry...
    t.setNow('2027-01-02T05:00:00Z');
    await openTestShift(t.app);
    // ...so moving the clock back to October doesn't make SOON sellable again.
    t.setNow('2026-10-21T09:00:00Z');
    expect((await listStock(t.app, { filter: 'expired' })).map((r) => r.batchNo)).toEqual([
      'GONE',
      'SOON',
    ]);
    const stock = await getProductStock(t.app, t.product.id);
    expect(stock.batches.find((b) => b.batchNo === 'SOON')?.status).toBe('expired');
    expect((await getStockSummary(t.app)).expiredBatches).toBe(2);
    expect((await planFefo(t.app, t.product.id, 10)).allocations).toHaveLength(1);
  });
});

describe('stock cache', () => {
  it('always matches the ledger and can be rebuilt', async () => {
    const { app, db, product } = await withPanadol();
    const { batchId } = await addOpeningStock(app, {
      productId: product.id,
      expiryDate: null,
      qty: 12,
    });
    await adjustStock(app, { batchId, qtyDelta: -2, reason: 'Count' });
    expect(await findStockCacheMismatches(db)).toEqual([]);

    await db.updateTable('batch_stock').set({ qty: 999 }).execute();
    expect(await findStockCacheMismatches(db)).toEqual([
      { branchId: app.session.branchId, batchId, cached: 999, ledger: 10 },
    ]);
    await rebuildStockCache(db);
    expect(await findStockCacheMismatches(db)).toEqual([]);
    expect((await getProductStock(app, product.id)).totalQty).toBe(10);
  });
});
