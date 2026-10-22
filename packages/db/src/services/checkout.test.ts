import {
  confirmInDate,
  pickBatches,
  setPackBatch,
  setPrescription,
  setPrice,
  setQty,
  setRxCheck,
  type Cart,
} from '@app/core';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { Db } from '../executor';
import { META, setMeta } from '../meta';
import { insertRow } from '../writes';
import {
  asRole,
  checkout,
  createTestApp,
  openTestShift,
  ringUp,
  tabletInput,
  type TestApp,
} from '../test-helpers';
import { createProduct, getProduct, toProductInput, updateProduct } from './catalog';
import { completeSale, getSellable, grantApproval, planSale } from './checkout';
import { checkRecords } from './integrity';
import { saveDraft } from './drafts';
import { describeRefund, getSale, listSales, voidSale, findSale } from './sales';
import { updateStoreSettings } from './settings';
import { closeShift, getOpenShift, getShiftTotals } from './shift';
import { addOpeningStock, findStockCacheMismatches, getProductStock } from './stock';

/**
 * The worked sale from docs/m2-design.md §3.1:
 *   Panadol 500mg 2 strips, Brufen 400mg 3 tablets (no stock on record),
 *   Augmentin 625mg 8 tablets at 10% off, a thermometer (18% tax, never discounted),
 *   and 2% off the bill. Total Rs 1,965.00 (rounding −0.39).
 */
async function store(t?: TestApp) {
  t ??= await createTestApp();
  const now = '2026-10-21T09:00:00.000Z';
  const vat = 'tax-18';
  await t.db.transaction().execute((trx) =>
    insertRow(trx, now, 'tax_class', {
      id: vat,
      name: 'GST 18%',
      rate_bp: 1800,
      is_active: 1,
      created_at: now,
      updated_at: now,
    }),
  );
  const panadol = await createProduct(t.app, tabletInput());
  const brufen = await createProduct(
    t.app,
    tabletInput({
      name: 'Brufen',
      strength: '400mg',
      manufacturer: 'Abbott',
      ingredients: [{ generic: 'Ibuprofen', strength: '400mg' }],
      units: [
        { name: 'Tablet', qty: 1, isSellable: true, barcodes: [] },
        { name: 'Strip', qty: 10, isSellable: true, barcodes: [] },
      ],
      salePrice: 24567,
      priceQty: 10,
      costPrice: null,
    }),
  );
  const augmentin = await createProduct(
    t.app,
    tabletInput({
      name: 'Augmentin',
      strength: '625mg',
      ingredients: [{ generic: 'Amoxicillin', strength: '500mg' }],
      units: [
        { name: 'Tablet', qty: 1, isSellable: true, barcodes: [] },
        { name: 'Strip', qty: 6, isSellable: true, barcodes: [] },
        { name: 'Box', qty: 18, isSellable: true, barcodes: ['8961234567890'] },
      ],
      salePrice: 43620,
      priceQty: 6,
      costPrice: 37077,
      rxRequired: true,
    }),
  );
  const thermometer = await createProduct(t.app, {
    name: 'Thermometer',
    form: 'device',
    units: [{ name: 'Piece', qty: 1, isSellable: true, barcodes: [] }],
    salePrice: 89999,
    priceQty: 1,
    costPrice: 60000,
    taxClassId: vat,
    allowDiscount: false,
  });
  const pn01 = await addOpeningStock(t.app, {
    productId: panadol.id,
    batchNo: 'PN-01',
    expiryDate: '2027-01-31',
    qty: 15,
    costPrice: 62475,
    mrp: 73500,
  });
  const pn02 = await addOpeningStock(t.app, {
    productId: panadol.id,
    batchNo: 'PN-02',
    expiryDate: '2027-06-30',
    qty: 30,
    costPrice: 62475,
    mrp: 73500,
  });
  const au = await addOpeningStock(t.app, {
    productId: augmentin.id,
    batchNo: 'AU1123',
    expiryDate: '2027-03-31',
    qty: 18,
    costPrice: 37077,
    mrp: 41500,
  });
  await addOpeningStock(t.app, {
    productId: thermometer.id,
    batchNo: 'TH-1',
    expiryDate: null,
    qty: 5,
    costPrice: 60000,
  });
  return {
    ...t,
    panadol,
    brufen,
    augmentin,
    thermometer,
    batches: { pn01: pn01.batchId, pn02: pn02.batchId, au: au.batchId },
  };
}

type Store = Awaited<ReturnType<typeof store>>;

async function workedCart(s: Store, app = s.app): Promise<Cart> {
  const cart = await ringUp(
    app,
    [
      { productId: s.panadol.id, unit: 'Strip', qty: 2 },
      { productId: s.brufen.id, unit: 'Tablet', qty: 3 },
      {
        productId: s.augmentin.id,
        unit: 'Tablet',
        qty: 8,
        discount: { kind: 'percent', bp: 1000 },
      },
      { productId: s.thermometer.id, qty: 1 },
    ],
    { kind: 'percent', bp: 200 },
  );
  return setRxCheck(cart, 'seen');
}

const SPLIT = [
  { method: 'card' as const, amount: 100000, reference: '4417' },
  { method: 'cash' as const, tendered: 100000 },
];

async function counts(db: Db) {
  const tables = [
    'sale',
    'sale_line',
    'sale_line_batch',
    'stock_movement',
    'payment',
    'batch',
    'sync_outbox',
    'audit_log',
    'sale_draft',
  ];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const r = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql.table(table)}`.execute(db);
    out[table] = r.rows[0]!.n;
  }
  return out;
}

describe('planSale', () => {
  it('prices the worked sale to the paisa and lists what to check', async () => {
    const s = await store();
    await openTestShift(s.app);
    const plan = await planSale(s.app, await workedCart(s));
    expect(plan.fields).toEqual({});
    expect(plan.totals).toEqual({
      grossTotal: 204529,
      lineDiscountTotal: 5816,
      billDiscount: 2174,
      subtotal: 196539,
      rounding: -39,
      total: 196500,
      taxTotal: 13729,
    });
    expect(plan.lines.map((l) => [l.gross, l.lineDiscount, l.billShare, l.net, l.tax])).toEqual([
      [49000, 0, 980, 48020, 0],
      [7370, 0, 147, 7223, 0],
      [58160, 5816, 1047, 51297, 0],
      [89999, 0, 0, 89999, 13729],
    ]);
    // Panadol: first to expire first; Brufen has no stock on record.
    expect(plan.lines[0]!.parts.map((p) => [p.batchNo, p.qty, p.pick])).toEqual([
      ['PN-01', 15, 'fefo'],
      ['PN-02', 5, 'fefo'],
    ]);
    expect(plan.lines[1]!.parts).toMatchObject([{ qty: 3, pick: 'unrecorded', placeholder: true }]);
    expect(plan.warnings).toContainEqual({ kind: 'past_zero', lineKey: 'k2', recorded: 0, qty: 3 });
    // Augmentin at 10% off is under its MRP, so no MRP warning.
    expect(plan.warnings.filter((w) => w.kind === 'above_mrp')).toEqual([]);
    // The owner may give 11.8%; nothing needs approval.
    expect(plan.needs).toEqual([]);
  });

  it('asks a cashier for approval of a discount above the cap', async () => {
    const s = await store();
    const cashier = await asRole(s, 'cashier');
    await openTestShift(cashier.app);
    const plan = await planSale(cashier.app, await workedCart(s, cashier.app));
    expect(plan.needs).toEqual([{ kind: 'sale.discount', lineKey: 'k3', needBp: 1180 }]);
  });
});

describe('completeSale', () => {
  it('records the worked sale: header, lines, batches, stock, payments and sync', async () => {
    const s = await store();
    const shift = await openTestShift(s.app);
    const before = await counts(s.db);
    const cart = await workedCart(s);
    const done = await checkout(s.app, cart, SPLIT);
    expect(done).toEqual({
      saleId: cart.id,
      invoiceNo: 'T1-000001',
      total: 196500,
      change: 3500,
      cashReceived: 96500,
      alreadyCompleted: false,
      openDrawer: true,
    });

    const sale = await s.db.selectFrom('sale').selectAll().executeTakeFirstOrThrow();
    expect(sale).toMatchObject({
      id: cart.id,
      shift_id: shift.id,
      invoice_seq: 1,
      business_date: '2026-10-21',
      line_count: 4,
      gross_total: 204529,
      line_discount_total: 5816,
      bill_discount_bp: 200,
      bill_discount: 2174,
      subtotal: 196539,
      rounding: -39,
      total: 196500,
      tax_total: 13729,
      change_given: 3500,
      rx_check: 'seen',
      // Brufen has no cost on record, so the sale's cost is unknown.
      cost_total: null,
    });
    const lines = await s.db.selectFrom('sale_line').selectAll().orderBy('line_no').execute();
    expect(lines.map((l) => [l.description, l.qty_text, l.net, l.discount_source])).toEqual([
      ['Panadol 500mg', '2 Strips', 48020, 'none'],
      ['Brufen 400mg', '3 Tablets', 7223, 'none'],
      ['Augmentin 625mg', '8 Tablets', 51297, 'manual'],
      ['Thermometer', '1 Piece', 89999, 'none'],
    ]);
    expect(lines[2]).toMatchObject({ line_discount_bp: 1000, rx_required: 1, above_mrp: 0 });
    expect(lines[3]).toMatchObject({ tax_rate_bp: 1800, tax: 13729 });

    const allocations = await s.db
      .selectFrom('sale_line_batch')
      .selectAll()
      .orderBy('created_at')
      .execute();
    expect(allocations.map((a) => [a.batch_no, a.qty, a.pick, a.stock_before])).toEqual([
      ['PN-01', 15, 'fefo', 15],
      ['PN-02', 5, 'fefo', 30],
      ['', 3, 'unrecorded', 0],
      ['AU1123', 8, 'fefo', 18],
      ['TH-1', 1, 'fefo', 5],
    ]);
    expect(allocations[0]).toMatchObject({ cost: 31238, mrp: 36750, expiry_date: '2027-01-31' });

    // Stock: real batches never go negative; the shortfall is on the placeholder.
    expect(
      (await getProductStock(s.app, s.panadol.id)).batches.map((b) => [b.batchNo, b.qty]),
    ).toEqual([['PN-02', 25]]);
    const brufen = await getProductStock(s.app, s.brufen.id);
    expect(brufen.batches).toMatchObject([{ isPlaceholder: true, qty: -3 }]);
    expect(await findStockCacheMismatches(s.db)).toEqual([]);

    const payments = await s.db.selectFrom('payment').selectAll().orderBy('method').execute();
    expect(
      payments.map((p) => [p.method, p.amount, p.tendered, p.change_given, p.reference]),
    ).toEqual([
      ['card', 100000, null, null, '4417'],
      ['cash', 96500, 100000, 3500, null],
    ]);

    // Every synced insert is queued, and the draft is gone.
    const after = await counts(s.db);
    expect(after.sale_draft).toBe(before.sale_draft); // the draft started for this sale is gone
    const queued = await s.db
      .selectFrom('sync_outbox')
      .select(['table_name'])
      .where('seq', '>', before.sync_outbox ?? 0)
      .execute();
    const byTable = queued.reduce<Record<string, number>>(
      (acc, r) => ({ ...acc, [r.table_name]: (acc[r.table_name] ?? 0) + 1 }),
      {},
    );
    expect(byTable).toMatchObject({
      sale: 1,
      sale_line: 4,
      sale_line_batch: 5,
      stock_movement: 5,
      payment: 2,
      batch: 1, // Brufen's placeholder
    });
    const audits = await s.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', cart.id)
      .execute();
    expect(audits.map((a) => a.action).sort()).toEqual(['sale.discount', 'sale.past_zero']);

    const totals = await getShiftTotals(s.app, shift.id);
    expect(totals).toMatchObject({
      sales: { count: 1, total: 196500 },
      payments: { cash: { net: 96500 }, card: { net: 100000 } },
      expectedCash: 596500,
      flags: { unrecorded: 1 },
    });
  });

  it('numbers invoices without gaps, from the floor after a restore', async () => {
    const s = await store();
    await openTestShift(s.app);
    const sell = async () =>
      (await checkout(s.app, await ringUp(s.app, [{ productId: s.panadol.id, qty: 1 }]))).invoiceNo;
    expect(await sell()).toBe('T1-000001');
    expect(await sell()).toBe('T1-000002');
    await setMeta(s.db, META.invoiceFloor, '50');
    expect(await sell()).toBe('T1-000050');
    expect(await sell()).toBe('T1-000051');
  });

  it('writes nothing at all if any part fails', async () => {
    const s = await store();
    await openTestShift(s.app);
    const cart = await workedCart(s);
    await saveDraft(s.app, cart);
    const before = await counts(s.db);
    await sql`CREATE TEMP TRIGGER fail BEFORE INSERT ON payment
              BEGIN SELECT RAISE(ABORT, 'disk unplugged'); END`.execute(s.db);
    await expect(
      completeSale(s.app, { draftId: cart.id, tenders: SPLIT, expectedTotal: 196500 }),
    ).rejects.toThrow(/disk unplugged/);
    expect(await counts(s.db)).toEqual(before);
    // The draft is still there to try again.
    await sql`DROP TRIGGER fail`.execute(s.db);
    await completeSale(s.app, { draftId: cart.id, tenders: SPLIT, expectedTotal: 196500 });
  });

  it('returns the same sale when completed twice', async () => {
    const s = await store();
    await openTestShift(s.app);
    const cart = await workedCart(s);
    const first = await checkout(s.app, cart, SPLIT);
    const before = await counts(s.db);
    const again = await completeSale(s.app, {
      draftId: cart.id,
      tenders: SPLIT,
      expectedTotal: 196500,
    });
    expect(again).toEqual({ ...first, alreadyCompleted: true });
    expect(await counts(s.db)).toEqual(before);
    // A late draft save after completion changes nothing.
    expect(await saveDraft(s.app, cart)).toEqual({ saved: false });
  });

  it('refuses when the total changed since the screen priced it', async () => {
    const s = await store();
    await openTestShift(s.app);
    const cart = await ringUp(s.app, [{ productId: s.panadol.id, unit: 'Strip', qty: 1 }]);
    const current = await getProduct(s.app, s.panadol.id);
    await updateProduct(s.app, s.panadol.id, { ...toProductInput(current!), salePrice: 75000 });
    await expect(
      completeSale(s.app, {
        draftId: cart.id,
        tenders: [{ method: 'cash', tendered: 50000 }],
        expectedTotal: 24500,
      }),
    ).rejects.toMatchObject({
      code: 'TOTAL_CHANGED',
      message: 'The total is now Rs 250.00 — check the bill',
    });
    const plan = await planSale(s.app, cart);
    expect(plan.warnings).toContainEqual({
      kind: 'price_changed',
      lineKey: 'k1',
      price: { amount: 75000, perQty: 30 },
    });
  });

  it('needs an open shift, and refuses khata and short payments', async () => {
    const s = await store();
    const cart = await ringUp(s.app, [{ productId: s.panadol.id, qty: 10 }]);
    const complete = (tenders: Parameters<typeof completeSale>[1]['tenders']) =>
      completeSale(s.app, { draftId: cart.id, tenders, expectedTotal: 24500 });
    await expect(complete([{ method: 'cash', tendered: 24500 }])).rejects.toMatchObject({
      code: 'NO_SHIFT',
    });
    await openTestShift(s.app);
    await expect(complete([{ method: 'khata', amount: 24500 }])).rejects.toMatchObject({
      code: 'NOT_AVAILABLE',
    });
    await expect(complete([{ method: 'cash', tendered: 20000 }])).rejects.toMatchObject({
      code: 'VALIDATION',
      fields: { tenders: 'Rs 45.00 still to pay' },
    });
    await expect(
      complete([{ method: 'wallet', provider: 'jazzcash', amount: 24500, reference: '12' }]),
    ).rejects.toMatchObject({ fields: { 'tenders.0.reference': expect.any(String) } });
    await complete([
      { method: 'wallet', provider: 'jazzcash', amount: 24500, reference: '81726354' },
    ]);
  });

  it('uses one placeholder per product, created once', async () => {
    const s = await store();
    await openTestShift(s.app);
    await checkout(s.app, await ringUp(s.app, [{ productId: s.brufen.id, qty: 2 }]));
    await checkout(s.app, await ringUp(s.app, [{ productId: s.brufen.id, qty: 4 }]));
    const placeholders = await s.db
      .selectFrom('batch')
      .select('id')
      .where('product_id', '=', s.brufen.id)
      .where('is_placeholder', '=', 1)
      .execute();
    expect(placeholders).toHaveLength(1);
    expect((await getProductStock(s.app, s.brufen.id)).totalQty).toBe(-6);

    // Selling past recorded stock: real batches stop at zero, the rest is unrecorded.
    await checkout(
      s.app,
      setRxCheck(await ringUp(s.app, [{ productId: s.augmentin.id, qty: 20 }]), 'seen'),
    );
    const stock = await getProductStock(s.app, s.augmentin.id, { includeEmpty: true });
    expect(stock.batches.map((b) => [b.batchNo, b.qty, b.isPlaceholder])).toEqual([
      ['AU1123', 0, false],
      ['', -2, true],
    ]);
  });

  it('asks to confirm the packs are in date when expired stock is on record', async () => {
    const s = await store();
    await openTestShift(s.app);
    await addOpeningStock(s.app, {
      productId: s.brufen.id,
      batchNo: 'BR-OLD',
      expiryDate: '2026-09-30',
      qty: 20,
    });
    let cart = await ringUp(s.app, [{ productId: s.brufen.id, qty: 10 }]);
    await expect(checkout(s.app, cart)).rejects.toMatchObject({
      code: 'NEEDS_CONFIRMATION',
      details: {
        confirm: 'in_date',
        lines: [
          {
            key: 'k1',
            inDate: 0,
            shortfall: 10,
            expiredQty: 20,
            expiredBatches: [{ batchNo: 'BR-OLD', expiryDate: '2026-09-30', qty: 20 }],
          },
        ],
      },
    });
    cart = confirmInDate(cart, 'k1');
    await checkout(s.app, cart);
    const audit = await s.db
      .selectFrom('audit_log')
      .select('after_json')
      .where('action', '=', 'sale.expired_on_record')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(audit.after_json!).lines[0]).toMatchObject({ shortfall: 10, expiredQty: 20 });
  });

  it('refuses a hand-picked expired batch, on the field', async () => {
    const s = await store();
    await openTestShift(s.app);
    const old = await addOpeningStock(s.app, {
      productId: s.panadol.id,
      batchNo: 'PN-00',
      expiryDate: '2026-09-30',
      qty: 10,
    });
    let cart = await ringUp(s.app, [{ productId: s.panadol.id, qty: 5 }]);
    cart = pickBatches(cart, 'k1', [{ batchId: old.batchId, qty: 5 }]);
    const plan = await planSale(s.app, cart);
    expect(plan.fields).toEqual({
      'lines.0.batches.0.batchId': 'Batch PN-00 expired (Sep 2026) — cannot be sold',
    });
    await saveDraft(s.app, cart);
    await expect(
      completeSale(s.app, { draftId: cart.id, tenders: [], expectedTotal: 0 }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('warns above MRP, records it, and can sell at the MRP', async () => {
    const s = await store();
    await openTestShift(s.app);
    let cart = setRxCheck(await ringUp(s.app, [{ productId: s.augmentin.id, qty: 8 }]), 'seen');
    let plan = await planSale(s.app, cart);
    // 8 tablets: Rs 581.60 at the catalog price, Rs 553.33 at MRP.
    expect(plan.warnings).toContainEqual({
      kind: 'above_mrp',
      lineKey: 'k1',
      mrpPrice: { amount: 41500, perQty: 6 },
      over: 2827,
    });
    const first = await checkout(s.app, cart);
    const line = await s.db
      .selectFrom('sale_line')
      .select(['above_mrp'])
      .where('sale_id', '=', first.saleId)
      .executeTakeFirstOrThrow();
    expect(line.above_mrp).toBe(1);
    expect(
      await s.db
        .selectFrom('audit_log')
        .select('action')
        .where('action', '=', 'sale.above_mrp')
        .execute(),
    ).toHaveLength(1);

    cart = setRxCheck(await ringUp(s.app, [{ productId: s.augmentin.id, qty: 8 }]), 'seen');
    cart = setPrice(cart, 'k1', { amount: 41500, perQty: 6 }, 'mrp');
    plan = await planSale(s.app, cart);
    expect(plan.lines[0]).toMatchObject({ priceSource: 'mrp', gross: 55333, aboveMrp: null });
    await checkout(s.app, cart);
  });

  it('lets a pharmacist approve a cashier’s discount, for exactly that line', async () => {
    const s = await store();
    const cashier = await asRole(s, 'cashier');
    const pharmacist = await asRole(s, 'pharmacist');
    await openTestShift(cashier.app);
    const cart = await workedCart(s, cashier.app);
    await saveDraft(cashier.app, cart);
    await expect(checkout(cashier.app, cart, SPLIT)).rejects.toMatchObject({
      code: 'NEEDS_APPROVAL',
      message: 'A 11.80% discount on Augmentin 625mg needs a PIN from a pharmacist or the owner',
      details: { kind: 'sale.discount', lineKey: 'k3', needBp: 1180 },
    });

    // The approval is for the line as saved; the need is worked out by the service.
    expect(
      await grantApproval(cashier.app, {
        draftId: cart.id,
        kind: 'sale.discount',
        lineKey: 'k3',
        userId: pharmacist.id,
        pin: pharmacist.pin,
      }),
    ).toEqual({ approverName: 'Pharmacist', approvedBp: 1180 });

    // Changing the approved line needs a new approval.
    const changed = setQty(cart, 'k3', 9);
    await saveDraft(cashier.app, changed);
    expect((await planSale(cashier.app, changed)).needs).toMatchObject([{ lineKey: 'k3' }]);

    await saveDraft(cashier.app, cart);
    expect((await planSale(cashier.app, cart)).needs).toEqual([]);
    const done = await checkout(cashier.app, cart, SPLIT);
    const line = await s.db
      .selectFrom('sale_line')
      .select(['approved_by'])
      .where('sale_id', '=', done.saleId)
      .where('line_no', '=', 3)
      .executeTakeFirstOrThrow();
    expect(line.approved_by).toBe(pharmacist.id);
    const audit = await s.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'sale.discount')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ user_id: cashier.id, approved_by: pharmacist.id });
  });

  it('records the prescription and dispenser for a controlled drug', async () => {
    const s = await store();
    const cashier = await asRole(s, 'cashier');
    const pharmacist = await asRole(s, 'pharmacist');
    await openTestShift(cashier.app);
    const diazepam = await createProduct(
      s.app,
      tabletInput({
        name: 'Valium',
        strength: '5mg',
        ingredients: [{ generic: 'Diazepam', strength: '5mg' }],
        units: [
          { name: 'Tablet', qty: 1, isSellable: true, barcodes: [] },
          { name: 'Strip', qty: 10, isSellable: true, barcodes: [] },
        ],
        salePrice: 5000,
        priceQty: 10,
        controlledSchedule: 'B',
      }),
    );
    let cart = await ringUp(cashier.app, [{ productId: diazepam.id, qty: 10 }]);
    let plan = await planSale(cashier.app, cart);
    // No batch on record: it must be typed from the pack.
    expect(plan.fields).toEqual({ 'lines.0.batches': 'Pick the batch printed on the pack' });

    cart = setPackBatch(cart, 'k1', { batchNo: 'VX221', expiryDate: '2027-12-31', mrp: 5200 });
    plan = await planSale(cashier.app, cart);
    expect(plan.fields).toEqual({});
    expect(plan.payFields).toEqual({
      'prescription.patientName': 'Enter the patient’s name',
      'prescription.prescriberName': 'Enter the doctor’s name',
    });
    expect(plan.needs).toEqual([{ kind: 'sale.controlled', lineKey: '' }]);

    cart = setPrescription(cart, { patientName: 'Ali Raza', prescriberName: 'Dr Khan' });
    await saveDraft(cashier.app, cart);
    await expect(checkout(cashier.app, cart)).rejects.toMatchObject({
      code: 'NEEDS_APPROVAL',
      details: { permission: 'sale.controlled' },
    });
    await grantApproval(cashier.app, {
      draftId: cart.id,
      kind: 'sale.controlled',
      lineKey: '',
      userId: pharmacist.id,
      pin: pharmacist.pin,
    });
    const done = await checkout(cashier.app, cart);
    const rx = await s.db.selectFrom('sale_prescription').selectAll().executeTakeFirstOrThrow();
    expect(rx).toMatchObject({
      sale_id: done.saleId,
      patient_name: 'Ali Raza',
      prescriber_name: 'Dr Khan',
      dispensed_by: pharmacist.id,
    });
    // The typed pack became a real batch, never the placeholder.
    const batch = await s.db
      .selectFrom('batch')
      .selectAll()
      .where('product_id', '=', diazepam.id)
      .executeTakeFirstOrThrow();
    expect(batch).toMatchObject({
      batch_no: 'VX221',
      expiry_date: '2027-12-31',
      is_placeholder: 0,
      source: 'adjustment',
    });
    expect((await getSale(s.app, done.saleId))?.prescription).toEqual({
      patientName: 'Ali Raza',
      prescriberName: 'Dr Khan',
      dispensedBy: 'Pharmacist',
    });
  });

  it('records "prescription not seen", or refuses it when the store requires it', async () => {
    const s = await store();
    await openTestShift(s.app);
    let cart = await ringUp(s.app, [{ productId: s.augmentin.id, unit: 'Strip', qty: 1 }]);
    expect((await planSale(s.app, cart)).payFields).toEqual({
      rxCheck: 'Was the prescription seen?',
    });
    cart = setRxCheck(cart, 'not_seen');
    await checkout(s.app, cart);
    expect(
      await s.db
        .selectFrom('audit_log')
        .select('action')
        .where('action', '=', 'sale.rx_not_seen')
        .execute(),
    ).toHaveLength(1);

    await updateStoreSettings(s.app, { rxCheck: 'require_seen' });
    cart = setRxCheck(await ringUp(s.app, [{ productId: s.augmentin.id, qty: 6 }]), 'not_seen');
    await expect(checkout(s.app, cart)).rejects.toMatchObject({
      fields: { rxCheck: 'This store needs the prescription to be seen' },
    });
  });

  it('settles a zero bill with no payments', async () => {
    const s = await store();
    await openTestShift(s.app);
    const cart = await ringUp(s.app, [
      { productId: s.panadol.id, qty: 10, discount: { kind: 'percent', bp: 10_000 } },
    ]);
    const done = await checkout(s.app, cart);
    expect(done).toMatchObject({ total: 0, cashReceived: 0, openDrawer: false });
    expect(await s.db.selectFrom('payment').selectAll().execute()).toEqual([]);
  });

  it('refuses an impossible date, and checks expiry against the last record', async () => {
    const s = await store();
    await openTestShift(s.app);
    s.setNow('2009-01-01T09:00:00Z');
    const cart = await ringUp(s.app, [{ productId: s.panadol.id, qty: 1 }]);
    await expect(checkout(s.app, cart)).rejects.toMatchObject({ code: 'CLOCK_WRONG' });

    // Back to 21 Oct; a sale recorded at 19:30 UTC (00:30 on the 22nd in Karachi).
    s.setNow('2026-10-21T19:30:00Z');
    await checkout(s.app, await ringUp(s.app, [{ productId: s.panadol.id, qty: 1 }]));
    // The clock then goes back to 09:00 on the 21st: a batch expiring on the 21st is now
    // treated as expired, because "today" can't be earlier than the last record.
    s.setNow('2026-10-21T09:00:00Z');
    const today = await addOpeningStock(s.app, {
      productId: s.thermometer.id,
      batchNo: 'TH-OLD',
      expiryDate: '2026-10-21',
      qty: 1,
    });
    const sellable = await getSellable(s.app, s.thermometer.id);
    expect(sellable?.batches.find((b) => b.batchId === today.batchId)?.status).toBe('expired');
    const plan = await planSale(s.app, await ringUp(s.app, [{ productId: s.panadol.id, qty: 1 }]));
    expect(plan.warnings.some((w) => w.kind === 'clock_behind')).toBe(true);
  });

  it('doesn’t let an inventory clerk sell', async () => {
    const s = await store();
    await openTestShift(s.app);
    const clerk = await asRole(s, 'inventory');
    const cart = await ringUp(clerk.app, [{ productId: s.panadol.id, qty: 1 }]);
    await expect(checkout(clerk.app, cart)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('hides costs from cashiers', async () => {
    const s = await store();
    const cashier = await asRole(s, 'cashier');
    expect((await getSellable(s.app, s.panadol.id))?.batches[0]?.cost).toEqual({
      amount: 62475,
      perQty: 30,
    });
    expect((await getSellable(cashier.app, s.panadol.id))?.batches[0]?.cost).toBeNull();
  });
});

describe('voidSale', () => {
  it('reverses stock and payments exactly, once, and only in the same shift', async () => {
    const s = await store();
    const cashier = await asRole(s, 'cashier');
    const pharmacist = await asRole(s, 'pharmacist');
    const shift = await openTestShift(cashier.app);
    const done = await checkout(s.app, await workedCart(s), SPLIT);

    await expect(
      voidSale(cashier.app, { saleId: done.saleId, reason: 'Rang up twice' }),
    ).rejects.toMatchObject({ code: 'NEEDS_APPROVAL', details: { permission: 'sale.void' } });
    const result = await voidSale(cashier.app, {
      saleId: done.saleId,
      reason: 'Rang up twice',
      approval: { userId: pharmacist.id, pin: pharmacist.pin },
    });
    expect(result).toMatchObject({
      invoiceNo: 'T1-000001',
      cashToGiveBack: 96500,
      nonCash: [{ method: 'card', amount: 100000, reference: '4417' }],
      openDrawer: true,
    });
    expect(describeRefund(result)).toEqual([
      'Give back Rs 965.00 cash',
      'Reverse the Rs 1,000.00 card payment (4417)',
    ]);

    const net = await s.db
      .selectFrom('payment')
      .select((eb) => eb.fn.sum<number>('amount').as('sum'))
      .where('sale_id', '=', done.saleId)
      .executeTakeFirstOrThrow();
    expect(Number(net.sum)).toBe(0);
    expect((await getProductStock(s.app, s.panadol.id)).totalQty).toBe(45);
    expect((await getProductStock(s.app, s.brufen.id)).totalQty).toBe(0);
    expect(await findStockCacheMismatches(s.db)).toEqual([]);

    const view = await getSale(s.app, done.saleId);
    expect(view?.voided).toMatchObject({ by: 'Cashier', approvedBy: 'Pharmacist' });
    expect(view?.canVoid).toBe(false);
    expect((await listSales(s.app))[0]).toMatchObject({ voided: true, methods: ['card', 'cash'] });
    expect((await getShiftTotals(s.app, shift.id)).sales.count).toBe(0);
    expect((await getShiftTotals(s.app, shift.id)).voids).toEqual({ count: 1, total: 196500 });

    await expect(voidSale(s.app, { saleId: done.saleId, reason: 'Again' })).rejects.toMatchObject({
      message: 'This sale is already voided',
    });

    // A sale from a closed shift needs a return instead.
    const other = await checkout(s.app, await ringUp(s.app, [{ productId: s.panadol.id, qty: 1 }]));
    const open = (await getOpenShift(s.app))!;
    await closeShift(s.app, { shiftId: open.id, countedCash: 500_000, floatLeft: 0, note: 'x' });
    await openTestShift(s.app);
    await expect(voidSale(s.app, { saleId: other.saleId, reason: 'Late' })).rejects.toMatchObject({
      message: 'This sale is from a closed shift — use a return',
    });
  });

  it('finds a sale from a typed or scanned number', async () => {
    const s = await store();
    await openTestShift(s.app);
    const done = await checkout(s.app, await ringUp(s.app, [{ productId: s.panadol.id, qty: 1 }]));
    for (const text of ['1', 'T1-000001', 't1 1', 'T1000001']) {
      expect((await findSale(s.app, text))?.id, text).toBe(done.saleId);
    }
    expect(await findSale(s.app, 'T2-000001')).toBeNull();
    expect(await listSales(s.app, { query: '000001' })).toHaveLength(1);
  });
});

describe('controlled drugs and hand-picked batches', () => {
  async function valium(s: Store) {
    return createProduct(
      s.app,
      tabletInput({
        name: 'Valium',
        strength: '5mg',
        ingredients: [{ generic: 'Diazepam', strength: '5mg' }],
        units: [
          { name: 'Tablet', qty: 1, isSellable: true, barcodes: [] },
          { name: 'Strip', qty: 10, isSellable: true, barcodes: [] },
        ],
        salePrice: 5000,
        priceQty: 10,
      }),
    );
  }

  it('never sells a controlled drug from unrecorded stock', async () => {
    const s = await store();
    await openTestShift(s.app);
    const p = await valium(s);
    // Sold before it was marked controlled, so it has an unrecorded-stock batch.
    await checkout(s.app, await ringUp(s.app, [{ productId: p.id, qty: 5 }]));
    const current = await getProduct(s.app, p.id);
    await updateProduct(s.app, p.id, { ...toProductInput(current!), controlledSchedule: 'B' });
    const placeholder = (await getSellable(s.app, p.id))!.batches.find((b) => b.placeholder)!;
    let cart = await ringUp(s.app, [{ productId: p.id, qty: 10 }]);
    cart = pickBatches(cart, 'k1', [{ batchId: placeholder.batchId, qty: 10 }]);
    expect((await planSale(s.app, cart)).fields).toEqual({
      'lines.0.batches.0.batchId': 'Pick the batch printed on the pack, or type it in',
    });
  });

  it('creates one batch for a pack typed on two lines, and warns past zero', async () => {
    const s = await store();
    await openTestShift(s.app);
    const p = await valium(s);
    const current = await getProduct(s.app, p.id);
    await updateProduct(s.app, p.id, { ...toProductInput(current!), controlledSchedule: 'B' });
    const pack = { batchNo: 'VX221', expiryDate: '2027-12-31', mrp: 5200 };
    let cart = await ringUp(s.app, [
      { productId: p.id, qty: 10, discount: { kind: 'percent', bp: 100 } },
      { productId: p.id, qty: 5 },
    ]);
    cart = setPackBatch(cart, 'k1', pack);
    cart = setPackBatch(cart, 'k2', pack);
    cart = setPrescription(cart, { patientName: 'Ali', prescriberName: 'Dr Khan' });
    const plan = await planSale(s.app, cart);
    expect(plan.warnings.filter((w) => w.kind === 'past_zero')).toHaveLength(2);
    await checkout(s.app, cart);
    const stock = await getProductStock(s.app, p.id, { includeEmpty: true });
    expect(stock.batches.map((b) => [b.batchNo, b.qty])).toEqual([['VX221', -15]]);
    expect(await checkRecords(s.db)).toEqual([]);
  });

  it('warns when a hand-picked batch is sold past its stock, even picked twice', async () => {
    const s = await store();
    await openTestShift(s.app);
    let cart = await ringUp(s.app, [{ productId: s.panadol.id, qty: 20 }]);
    cart = pickBatches(cart, 'k1', [
      { batchId: s.batches.pn01, qty: 10 },
      { batchId: s.batches.pn01, qty: 10 },
    ]);
    const plan = await planSale(s.app, cart);
    expect(plan.lines[0]!.parts).toMatchObject([{ batchNo: 'PN-01', qty: 20 }]);
    expect(plan.warnings).toContainEqual({
      kind: 'past_zero',
      lineKey: 'k1',
      recorded: 45,
      qty: 20,
    });
  });
});
