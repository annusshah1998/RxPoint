import { describe, expect, it } from 'vitest';
import { META, setMeta } from '../meta';
import {
  asRole,
  checkout,
  createTestApp,
  openTestShift,
  ringUp,
  tabletInput,
  workedCart,
  workedStore,
  WORKED_SPLIT,
  type WorkedStore,
} from '../test-helpers';
import { createProduct } from './catalog';
import { checkRecords } from './integrity';
import { getReturnReceiptData } from './receipt-data';
import {
  createReturn,
  getReturnableSale,
  planReturn,
  type CreateReturnInput,
  type ReturnLineRequest,
} from './returns';
import { describeRefund, getSale, listSales, voidSale } from './sales';
import { updateStoreSettings } from './settings';
import { closeShift, getOpenShift, getShiftTotals } from './shift';
import { addOpeningStock, findStockCacheMismatches, getProductStock } from './stock';
import type { AppContext } from '../context';

/** The worked sale (Rs 1,965.00, card Rs 1,000 + cash) and the ids of its four lines. */
async function soldWorkedSale(s: WorkedStore, app = s.app) {
  const done = await checkout(app, await workedCart(s, app), WORKED_SPLIT);
  const view = (await getSale(s.app, done.saleId))!;
  const [panadol, brufen, augmentin, thermometer] = view.lines.map((l) => l.id) as [
    string,
    string,
    string,
    string,
  ];
  return { saleId: done.saleId, lines: { panadol, brufen, augmentin, thermometer } };
}

/** Prices a return, then records it with the suggested refunds (or `refunds`). */
async function returnItems(
  app: AppContext,
  saleId: string,
  lines: ReturnLineRequest[],
  extra: Partial<CreateReturnInput> = {},
) {
  const plan = await planReturn(app, { saleId, lines });
  expect(plan.fields).toEqual({});
  return createReturn(app, {
    saleId,
    lines,
    reason: 'doctor_changed',
    refunds: plan.suggestedRefunds,
    expectedRefund: plan.refundTotal,
    ...extra,
  });
}

describe('returns', () => {
  it('refunds the worked example to the paisa, and the final return settles the rest', async () => {
    const s = await workedStore();
    await openTestShift(s.app);
    const { saleId, lines } = await soldWorkedSale(s);

    // Return 10 of the 20 Panadol tablets (m2-design §3.4).
    const plan = await planReturn(s.app, {
      saleId,
      lines: [{ saleLineId: lines.panadol, qty: 10, restock: true }],
    });
    expect(plan).toMatchObject({
      refundNet: 24010,
      rounding: -10,
      refundTotal: 24000,
      // Cost is shared per batch piece (10413 + 10413); each batch's cost was rounded at
      // sale time, so it is a paisa over half the line's 41650.
      costTotal: 20826,
      isFinal: false,
      fields: {},
      needs: [],
    });
    // FEFO took PN-01 (15) then PN-02 (5); the newest batch comes back first.
    expect(plan.lines[0]!.pieces.map((p) => [p.batchNo, p.qty, p.refund, p.restock])).toEqual([
      ['PN-02', 5, 12005, true],
      ['PN-01', 5, 12005, true],
    ]);
    // Cash back first, up to the cash paid.
    expect(plan.suggestedRefunds).toEqual([
      { method: 'cash', provider: null, reference: null, amount: 24000 },
    ]);

    const first = await returnItems(s.app, saleId, [
      { saleLineId: lines.panadol, qty: 10, restock: true },
    ]);
    expect(first).toMatchObject({
      returnNo: 'T1-R000001',
      invoiceNo: 'T1-000001',
      refundTotal: 24000,
      cashToGiveBack: 24000,
      nonCash: [],
      openDrawer: true,
    });
    expect(describeRefund(first)).toEqual(['Give back Rs 240.00 cash']);
    // 45 − 20 sold + 10 back.
    expect((await getProductStock(s.app, s.panadol.id)).totalQty).toBe(35);

    const left = await getReturnableSale(s.app, saleId);
    expect(left.lines.map((l) => [l.returnable, l.returnableText])).toEqual([
      [10, '1 Strip'],
      [3, '3 Tablets'],
      [8, '1 Strip, 2 Tablets'],
      [1, '1 Piece'],
    ]);
    expect(left.channels).toEqual([
      {
        method: 'cash',
        provider: null,
        reference: null,
        paid: 96500,
        refunded: 24000,
        left: 72500,
      },
      {
        method: 'card',
        provider: null,
        reference: '4417',
        paid: 100000,
        refunded: 0,
        left: 100000,
      },
    ]);

    // Everything else: exactly what is left of the sale total.
    const rest = [
      { saleLineId: lines.panadol, qty: 10, restock: true },
      { saleLineId: lines.brufen, qty: 3, restock: true },
      { saleLineId: lines.augmentin, qty: 8, restock: true },
      { saleLineId: lines.thermometer, qty: 1, restock: false },
    ];
    const finalPlan = await planReturn(s.app, { saleId, lines: rest });
    expect(finalPlan).toMatchObject({ isFinal: true, refundTotal: 172500 });
    expect(finalPlan.suggestedRefunds).toEqual([
      { method: 'cash', provider: null, reference: null, amount: 72500 },
      { method: 'card', provider: null, reference: '4417', amount: 100000 },
    ]);
    const second = await returnItems(s.app, saleId, rest);
    expect(second.returnNo).toBe('T1-R000002');
    expect(describeRefund(second)).toEqual([
      'Give back Rs 725.00 cash',
      'Reverse the Rs 1,000.00 card payment (4417)',
    ]);

    // The sale's payments now add up to nothing, and the thermometer stayed off the shelf.
    const net = await s.db
      .selectFrom('payment')
      .select((eb) => eb.fn.sum<number>('amount').as('sum'))
      .where('sale_id', '=', saleId)
      .executeTakeFirstOrThrow();
    expect(Number(net.sum)).toBe(0);
    expect((await getProductStock(s.app, s.panadol.id)).totalQty).toBe(45);
    expect((await getProductStock(s.app, s.augmentin.id)).totalQty).toBe(18);
    expect((await getProductStock(s.app, s.thermometer.id)).totalQty).toBe(4);
    const lineTax = await s.db
      .selectFrom('sale_return_line')
      .select((eb) => eb.fn.sum<number>('tax').as('tax'))
      .executeTakeFirstOrThrow();
    expect(Number(lineTax.tax)).toBe(13729);

    const view = await getSale(s.app, saleId);
    expect(view).toMatchObject({ returned: true, canReturn: false, canVoid: false });
    expect(view!.returns.map((r) => [r.returnNo, r.refundTotal])).toEqual([
      ['T1-R000001', 24000],
      ['T1-R000002', 172500],
    ]);
    expect((await listSales(s.app))[0]).toMatchObject({ returned: true, voided: false });
    expect((await getReturnableSale(s.app, saleId)).fullyReturned).toBe(true);

    // Nothing more can come back, and a void is now refused.
    await expect(
      planReturn(s.app, { saleId, lines: [{ saleLineId: lines.panadol, qty: 1 }] }),
    ).resolves.toMatchObject({ fields: { 'lines.0.qty': 'All of this was returned already' } });
    await expect(voidSale(s.app, { saleId, reason: 'x' })).rejects.toMatchObject({
      message: 'Part of this sale was returned — use a return',
    });

    expect(await checkRecords(s.db)).toEqual([]);
    expect(await findStockCacheMismatches(s.db)).toEqual([]);
  });

  it('gives the receipt one line per item, with its batches and how it was paid back', async () => {
    const s = await workedStore();
    const cashier = await asRole(s, 'cashier');
    const pharmacist = await asRole(s, 'pharmacist');
    await openTestShift(s.app);
    const { saleId, lines } = await soldWorkedSale(s);
    const done = await returnItems(
      cashier.app,
      saleId,
      [
        { saleLineId: lines.panadol, qty: 10 },
        { saleLineId: lines.thermometer, qty: 1, restock: false },
      ],
      { note: 'Wrong strength', approval: { userId: pharmacist.id, pin: pharmacist.pin } },
    );
    const data = await getReturnReceiptData(s.app, done.returnId);
    expect(data).toMatchObject({
      returnNo: 'T1-R000001',
      invoiceNo: 'T1-000001',
      tillCode: 'T1',
      cashier: 'Cashier',
      approvedBy: 'Pharmacist',
      copy: 'original',
      reason: 'doctor_changed',
      note: 'Wrong strength',
      refundNet: 24010 + 89999,
      refundTotal: 114000,
      taxByRate: [{ rateBp: 1800, tax: 13729 }],
      refunds: [
        { method: 'cash', amount: 96500 },
        { method: 'card', reference: '4417', amount: 17500 },
      ],
    });
    expect(data.lines).toEqual([
      {
        description: expect.stringContaining('Panadol'),
        qtyText: '1 Strip',
        refund: 24010,
        batches: [
          { batchNo: 'PN-02', expiryDate: '2027-06-30' },
          { batchNo: 'PN-01', expiryDate: '2027-01-31' },
        ],
      },
      {
        description: expect.stringContaining('Thermometer'),
        qtyText: '1 Piece',
        refund: 89999,
        batches: [{ batchNo: 'TH-1', expiryDate: null }],
      },
    ]);
  });

  it('says how much is left to return, in packs', async () => {
    const s = await workedStore();
    await openTestShift(s.app);
    const { saleId, lines } = await soldWorkedSale(s);
    const plan = await planReturn(s.app, {
      saleId,
      lines: [{ saleLineId: lines.augmentin, qty: 9 }],
    });
    expect(plan.fields).toEqual({ 'lines.0.qty': 'Only 1 Strip, 2 Tablets left to return' });
    await expect(
      createReturn(s.app, {
        saleId,
        lines: [{ saleLineId: lines.augmentin, qty: 9 }],
        reason: 'wrong_item',
        refunds: [],
        expectedRefund: 0,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      fields: { 'lines.0.qty': 'Only 1 Strip, 2 Tablets left to return' },
    });
    await expect(
      planReturn(s.app, { saleId, lines: [{ saleLineId: lines.augmentin, qty: 0 }] }),
    ).resolves.toMatchObject({ fields: { lines: 'Enter how many of an item are coming back' } });
  });

  it('needs a pharmacist for a cashier, the owner after the return window', async () => {
    const s = await workedStore();
    const cashier = await asRole(s, 'cashier');
    const pharmacist = await asRole(s, 'pharmacist');
    await openTestShift(cashier.app);
    const { saleId, lines } = await soldWorkedSale(s);
    const one = [{ saleLineId: lines.panadol, qty: 10 }];

    expect((await planReturn(cashier.app, { saleId, lines: one })).needs).toEqual(['sale.return']);
    await expect(returnItems(cashier.app, saleId, one)).rejects.toMatchObject({
      code: 'NEEDS_APPROVAL',
      message: 'Returns need a PIN from a pharmacist or the owner',
      details: { permission: 'sale.return', permissions: ['sale.return'] },
    });
    await expect(
      returnItems(cashier.app, saleId, one, { approval: { userId: pharmacist.id, pin: '0000' } }),
    ).rejects.toMatchObject({ code: 'WRONG_PIN' });
    const done = await returnItems(cashier.app, saleId, one, {
      approval: { userId: pharmacist.id, pin: pharmacist.pin },
    });
    const row = await s.db
      .selectFrom('sale_return')
      .select(['user_id', 'approved_by'])
      .where('id', '=', done.returnId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ user_id: cashier.id, approved_by: pharmacist.id });

    // Eight days later (the window is 7): the pharmacist's PIN is not enough.
    s.setNow('2026-10-29T09:00:00Z');
    const more = [{ saleLineId: lines.brufen, qty: 3 }];
    const late = await planReturn(cashier.app, { saleId, lines: more });
    expect(late).toMatchObject({ late: true, daysSince: 8 });
    expect(late.needs).toEqual(['sale.return', 'sale.return_late']);
    await expect(
      returnItems(cashier.app, saleId, more, {
        approval: { userId: pharmacist.id, pin: pharmacist.pin },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', fields: { userId: 'Needs the owner' } });
    await expect(returnItems(pharmacist.app, saleId, more)).rejects.toMatchObject({
      code: 'NEEDS_APPROVAL',
      message: 'This sale is 8 days old. Returns after 7 days need a PIN from the owner',
      details: { permissions: ['sale.return_late'] },
    });
    await expect(
      returnItems(cashier.app, saleId, more, {
        approval: { userId: s.app.session.userId, pin: s.ownerPin },
      }),
    ).resolves.toMatchObject({ returnNo: 'T1-R000002' });
  });

  it('never puts an expired batch back on the shelf', async () => {
    const s = await workedStore();
    await openTestShift(s.app);
    const { saleId, lines } = await soldWorkedSale(s);
    // Augmentin AU1123 expires end of March 2027; return it in April.
    s.setNow('2027-04-02T09:00:00Z');
    await updateStoreSettings(s.app, { returnDays: 365 });
    const plan = await planReturn(s.app, {
      saleId,
      lines: [{ saleLineId: lines.augmentin, qty: 6, restock: true }],
    });
    expect(plan.lines[0]!.pieces.map((p) => [p.batchNo, p.expired, p.restock])).toEqual([
      ['AU1123', true, false],
    ]);
    expect((await getReturnableSale(s.app, saleId)).lines[2]!.canRestock).toBe(false);
    const before = (await getProductStock(s.app, s.augmentin.id)).totalQty;
    await returnItems(s.app, saleId, [{ saleLineId: lines.augmentin, qty: 6, restock: true }]);
    expect((await getProductStock(s.app, s.augmentin.id)).totalQty).toBe(before);
    expect(await checkRecords(s.db)).toEqual([]);
  });

  it('caps card refunds, checks the drawer and the total, and refuses khata', async () => {
    const s = await workedStore();
    const cashier = await asRole(s, 'cashier');
    const pharmacist = await asRole(s, 'pharmacist');
    await openTestShift(s.app, 0);
    const { saleId, lines } = await soldWorkedSale(s);
    const all = [{ saleLineId: lines.thermometer, qty: 1 }];
    const plan = await planReturn(s.app, { saleId, lines: all });
    expect(plan.refundTotal).toBe(90000);
    const base = { saleId, lines: all, reason: 'damaged' as const, expectedRefund: 90000 };

    await expect(
      createReturn(s.app, { ...base, refunds: [{ method: 'cash', amount: 50000 }] }),
    ).rejects.toMatchObject({
      fields: { refunds: 'The refund adds up to Rs 500.00, but Rs 900.00 is due back' },
    });
    await expect(
      createReturn(s.app, {
        ...base,
        refunds: [{ method: 'wallet', provider: 'easypaisa', amount: 90000 }],
      }),
    ).rejects.toMatchObject({ fields: { 'refunds.0.amount': 'This sale wasn’t paid this way' } });
    await expect(
      createReturn(s.app, { ...base, refunds: [{ method: 'khata', amount: 90000 }] }),
    ).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    await expect(
      createReturn(s.app, { ...base, expectedRefund: 89000, refunds: plan.suggestedRefunds }),
    ).rejects.toMatchObject({ code: 'TOTAL_CHANGED', message: /Rs 900.00/ });

    // The float was 0 and the sale took Rs 965 in cash: Rs 900 fits, the next Rs 513 doesn’t.
    await createReturn(s.app, { ...base, refunds: [{ method: 'cash', amount: 90000 }] });
    const rest = [{ saleLineId: lines.augmentin, qty: 8 }];
    const p2 = await planReturn(s.app, { saleId, lines: rest });
    expect(p2.refundTotal).toBe(51300);
    await expect(
      createReturn(cashier.app, {
        saleId,
        lines: rest,
        reason: 'damaged',
        expectedRefund: 51300,
        refunds: [{ method: 'cash', amount: 51300 }],
        approval: { userId: pharmacist.id, pin: pharmacist.pin },
      }),
    ).rejects.toMatchObject({
      fields: { refunds: 'Not enough cash in the drawer for this refund' },
    });
    await expect(
      createReturn(s.app, {
        saleId,
        lines: rest,
        reason: 'damaged',
        expectedRefund: 51300,
        refunds: [{ method: 'cash', amount: 51300 }],
      }),
    ).rejects.toMatchObject({ fields: { refunds: 'Only Rs 65.00 should be in the drawer' } });
    // Card is capped at what was paid by card.
    await expect(
      createReturn(s.app, {
        saleId,
        lines: rest,
        reason: 'damaged',
        expectedRefund: 51300,
        refunds: [{ method: 'card', amount: 51300 }],
      }),
    ).resolves.toMatchObject({ nonCash: [{ method: 'card', reference: '4417', amount: 51300 }] });
    expect(await checkRecords(s.db)).toEqual([]);
  });

  it('takes back a zero-total sale with no refund, and refuses a voided sale', async () => {
    const t = await createTestApp();
    const panadol = await createProduct(t.app, tabletInput());
    await addOpeningStock(t.app, {
      productId: panadol.id,
      batchNo: 'PN-01',
      expiryDate: '2027-01-31',
      qty: 30,
    });
    await openTestShift(t.app);
    const free = await checkout(
      t.app,
      await ringUp(t.app, [
        { productId: panadol.id, qty: 10, discount: { kind: 'percent', bp: 10000 } },
      ]),
    );
    const line = (await getSale(t.app, free.saleId))!.lines[0]!.id;
    const plan = await planReturn(t.app, {
      saleId: free.saleId,
      lines: [{ saleLineId: line, qty: 10 }],
    });
    expect(plan).toMatchObject({ refundTotal: 0, suggestedRefunds: [] });
    const done = await returnItems(t.app, free.saleId, [{ saleLineId: line, qty: 10 }]);
    expect(done).toMatchObject({ refundTotal: 0, cashToGiveBack: 0, openDrawer: false });
    expect((await getProductStock(t.app, panadol.id)).totalQty).toBe(30);

    const sold = await checkout(t.app, await ringUp(t.app, [{ productId: panadol.id, qty: 1 }]));
    await voidSale(t.app, { saleId: sold.saleId, reason: 'Mistake' });
    await expect(getReturnableSale(t.app, sold.saleId)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: 'This sale was voided — nothing to return',
    });
    expect(await checkRecords(t.db)).toEqual([]);
  });

  it('goes into the open shift, numbers from the floor, and counts in the shift totals', async () => {
    const s = await workedStore();
    await openTestShift(s.app);
    const { saleId, lines } = await soldWorkedSale(s);
    const first = (await getOpenShift(s.app))!;
    await closeShift(s.app, {
      shiftId: first.id,
      countedCash: 500_000 + 96500,
      floatLeft: 500_000,
    });
    const second = await openTestShift(s.app);
    // After a restore (M5) the floor keeps return numbers from being reused.
    await s.db.transaction().execute((trx) => setMeta(trx, META.returnFloor, '40'));

    const done = await returnItems(s.app, saleId, [{ saleLineId: lines.panadol, qty: 10 }]);
    expect(done.returnNo).toBe('T1-R000040');
    const totals = await getShiftTotals(s.app, second.id);
    expect(totals.returns).toEqual({ count: 1, total: 24000 });
    expect(totals.expectedCash).toBe(500_000 - 24000);
    expect((await getShiftTotals(s.app, first.id)).returns.count).toBe(0);
    expect(await checkRecords(s.db)).toEqual([]);
  });

  it('needs a pharmacist to take back a controlled drug', async () => {
    const t = await createTestApp();
    const cashier = await asRole(t, 'cashier');
    const tramal = await createProduct(
      t.app,
      tabletInput({ name: 'Tramal', strength: '50mg', controlledSchedule: 'B' }),
    );
    await addOpeningStock(t.app, {
      productId: tramal.id,
      batchNo: 'TR-1',
      expiryDate: '2027-06-30',
      qty: 30,
    });
    await openTestShift(t.app);
    const view = await soldControlled(t.app, tramal.id);
    const lines = [{ saleLineId: view.lineId, qty: 10 }];
    expect((await planReturn(cashier.app, { saleId: view.saleId, lines })).needs).toEqual([
      'sale.return',
      'sale.controlled',
    ]);
    await expect(returnItems(cashier.app, view.saleId, lines)).rejects.toMatchObject({
      code: 'NEEDS_APPROVAL',
      details: { permissions: ['sale.return', 'sale.controlled'] },
    });
    await expect(returnItems(t.app, view.saleId, lines)).resolves.toMatchObject({
      returnNo: 'T1-R000001',
    });
  });
});

/** The owner sells 10 Tramal with a prescription, picking batch TR-1. */
async function soldControlled(app: AppContext, productId: string) {
  const { pickBatches, setPrescription, setRxCheck } = await import('@app/core');
  const { getSellable } = await import('./checkout');
  let cart = await ringUp(app, [{ productId, qty: 10 }]);
  const sellable = (await getSellable(app, productId))!;
  const batch = sellable.batches.find((b) => b.batchNo === 'TR-1')!;
  cart = pickBatches(cart, 'k1', [{ batchId: batch.batchId, qty: 10 }]);
  cart = setRxCheck(cart, 'seen');
  cart = setPrescription(cart, {
    patientName: 'Ali Raza',
    patientPhone: null,
    prescriberName: 'Dr Sana',
    prescriberRegNo: '12345-P',
    rxDate: '2026-10-20',
    rxRef: null,
  });
  const done = await checkout(app, cart);
  const view = (await getSale(app, done.saleId))!;
  return { saleId: done.saleId, lineId: view.lines[0]!.id };
}
