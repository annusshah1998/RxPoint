import { setRxCheck, type Tender } from '@app/core';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  asRole,
  checkout,
  createTestApp,
  openTestShift,
  ringUp,
  tabletInput,
} from '../test-helpers';
import { createProduct } from './catalog';
import { planSale } from './checkout';
import { checkRecords } from './integrity';
import { createReturn, planReturn } from './returns';
import { getSale, voidSale } from './sales';
import { closeShift, getShiftTotals, recordCashMovement } from './shift';
import { addOpeningStock, rebuildStockCache } from './stock';

describe('a full day of sales', () => {
  it('leaves records that add up', async () => {
    const t = await createTestApp();
    const cashier = await asRole(t, 'cashier');
    const pharmacist = await asRole(t, 'pharmacist');
    const panadol = await createProduct(t.app, tabletInput());
    const syrup = await createProduct(t.app, {
      name: 'Calpol',
      strength: '120mg/5ml',
      form: 'syrup',
      units: [{ name: 'Bottle', qty: 1, isSellable: true, barcodes: [] }],
      salePrice: 18500,
      priceQty: 1,
      costPrice: 15000,
    });
    await addOpeningStock(t.app, {
      productId: panadol.id,
      batchNo: 'PN-01',
      expiryDate: '2027-01-31',
      qty: 200,
      costPrice: 62475,
      mrp: 73500,
    });
    await addOpeningStock(t.app, {
      productId: syrup.id,
      batchNo: 'CP-9',
      expiryDate: '2027-05-31',
      qty: 10,
    });

    const shift = await openTestShift(cashier.app);
    let cash = 0;
    let card = 0;
    let wallet = 0;
    let salesTotal = 0;
    const saleIds: { id: string; total: number; cash: number }[] = [];
    for (let i = 0; i < 30; i++) {
      // Times move on through the day.
      t.setNow(new Date(Date.parse('2026-10-21T04:00:00Z') + i * 15 * 60_000).toISOString());
      const items = [{ productId: panadol.id, qty: 1 + (i % 7) * 3 }];
      if (i % 3 === 0) items.push({ productId: syrup.id, qty: 1 + (i % 2) });
      const cart = setRxCheck(await ringUp(cashier.app, items), 'seen');
      const total = (await planSale(cashier.app, cart)).totals!.total;
      let tenders: Tender[];
      if (i % 5 === 0) {
        tenders = [{ method: 'card', amount: total, reference: `C${i}` }];
        card += total;
      } else if (i % 7 === 0) {
        tenders = [
          { method: 'wallet', provider: 'easypaisa', amount: total, reference: `E${1000 + i}` },
        ];
        wallet += total;
      } else {
        tenders = [{ method: 'cash', tendered: total + (i % 4) * 1000 }];
        cash += total;
      }
      const done = await checkout(cashier.app, cart, tenders);
      salesTotal += total;
      saleIds.push({ id: done.saleId, total, cash: done.cashReceived });
    }

    // Two voids (with a pharmacist's PIN) and a pay-out.
    for (const v of [saleIds[3]!, saleIds[10]!]) {
      await voidSale(cashier.app, {
        saleId: v.id,
        reason: 'Customer changed mind',
        approval: { userId: pharmacist.id, pin: pharmacist.pin },
      });
      salesTotal -= v.total;
      cash -= v.cash;
      if (v.cash === 0) card -= v.total; // sale 10 was a card sale
    }
    await recordCashMovement(cashier.app, {
      kind: 'pay_out',
      category: 'expense',
      amount: 20_000,
      note: 'Cleaning',
    });

    // Three returns (a pharmacist approves): from a card sale, a cash sale and a wallet sale.
    let refunded = 0;
    for (const r of [saleIds[0]!, saleIds[1]!, saleIds[7]!]) {
      const view = (await getSale(t.app, r.id))!;
      const lines = [{ saleLineId: view.lines[0]!.id, qty: 1, restock: true }];
      const plan = await planReturn(cashier.app, { saleId: r.id, lines });
      const done = await createReturn(cashier.app, {
        saleId: r.id,
        lines,
        reason: 'side_effect',
        refunds: plan.suggestedRefunds,
        expectedRefund: plan.refundTotal,
        approval: { userId: pharmacist.id, pin: pharmacist.pin },
      });
      cash -= done.cashToGiveBack;
      for (const n of done.nonCash) {
        if (n.method === 'card') card -= n.amount;
        else wallet -= n.amount;
      }
      refunded += done.refundTotal;
    }
    expect(refunded).toBeGreaterThan(0);

    const totals = await getShiftTotals(t.app, shift.id);
    expect(totals.returns).toEqual({ count: 3, total: refunded });
    expect(totals.sales).toMatchObject({ count: 28, total: salesTotal });
    expect(totals.payments.cash.net).toBe(cash);
    expect(totals.payments.card.net).toBe(card);
    expect(totals.payments.wallet.net).toBe(wallet);
    expect(totals.expectedCash).toBe(500_000 + cash - 20_000);

    const closed = await closeShift(cashier.app, {
      shiftId: shift.id,
      countedCash: 500_000 + cash - 20_000,
      floatLeft: 500_000,
    });
    expect(closed.status).toBe('closed');

    expect(await checkRecords(t.db)).toEqual([]);
    // The stock cache rebuilt from the ledger is unchanged.
    const before = await t.db.selectFrom('batch_stock').selectAll().orderBy('batch_id').execute();
    await rebuildStockCache(t.db);
    expect(await t.db.selectFrom('batch_stock').selectAll().orderBy('batch_id').execute()).toEqual(
      before,
    );
  });

  it('notices records that don’t add up', async () => {
    const t = await createTestApp();
    const panadol = await createProduct(t.app, tabletInput());
    await openTestShift(t.app);
    await checkout(t.app, await ringUp(t.app, [{ productId: panadol.id, qty: 10 }]));
    expect(await checkRecords(t.db)).toEqual([]);
    // Tamper: drop the triggers that protect payments, then change one.
    await sql`DROP TRIGGER payment_no_update`.execute(t.db);
    await sql`UPDATE payment SET amount = amount - 100, tendered = tendered - 100`.execute(t.db);
    expect((await checkRecords(t.db)).map((p) => p.check)).toEqual(['sale_payments']);
  });
});
