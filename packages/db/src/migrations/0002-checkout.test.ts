import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createKysely, type Db } from '../executor';
import { migrate } from '../migrate';
import { createNodeExecutor } from '../node';
import { createProduct } from '../services/catalog';
import { addOpeningStock } from '../services/stock';
import { createTestApp, tabletInput } from '../test-helpers';
import { initial } from './0001-initial';
import { checkout } from './0002-checkout';

const AT = '2026-10-21T09:00:00.000Z';
const DAY = '2026-10-21';

describe('0002-checkout on an M1 database', () => {
  it('keeps the data and fills the new columns', async () => {
    const db = createKysely(createNodeExecutor());
    await migrate(db, [initial]);
    await sql`INSERT INTO branch (id, code, name, created_at, updated_at)
              VALUES ('b', 'MAIN', 'Shop', ${AT}, ${AT})`.execute(db);
    await sql`INSERT INTO device (id, branch_id, code, name, created_at, updated_at)
              VALUES ('d', 'b', 'T1', 'Till 1', ${AT}, ${AT})`.execute(db);
    await sql`INSERT INTO app_user (id, name, role, pin_hash, is_active, created_at, updated_at)
              VALUES ('u', 'Owner', 'owner', NULL, 1, ${AT}, ${AT})`.execute(db);
    await sql`INSERT INTO product (id, name, name_key, form, sale_price, price_qty, rx_required,
                is_active, created_at, updated_at)
              VALUES ('p', 'Panadol', 'panadol', 'tablet', 73500, 30, 0, 1, ${AT}, ${AT})`.execute(
      db,
    );
    await sql`INSERT INTO batch (id, product_id, batch_no, pack_qty, source, created_at, updated_at)
              VALUES ('x', 'p', 'AB1', 30, 'opening', ${AT}, ${AT})`.execute(db);
    await sql`INSERT INTO stock_movement (id, branch_id, device_id, product_id, batch_id, qty, kind,
                created_at)
              VALUES ('m', 'b', 'd', 'p', 'x', 60, 'opening', ${AT})`.execute(db);
    await sql`INSERT INTO audit_log (id, action, entity_type, entity_id, created_at)
              VALUES ('a', 'store.setup', 'branch', 'b', ${AT})`.execute(db);

    expect(await migrate(db, [initial, checkout])).toEqual(['0002-checkout']);

    expect(await db.selectFrom('product').select('allow_discount').execute()).toEqual([
      { allow_discount: 1 },
    ]);
    expect(await db.selectFrom('batch').select('is_placeholder').execute()).toEqual([
      { is_placeholder: 0 },
    ]);
    expect(await db.selectFrom('audit_log').select('approved_by').execute()).toEqual([
      { approved_by: null },
    ]);
    expect(await db.selectFrom('batch_stock').select('qty').execute()).toEqual([{ qty: 60 }]);
  });
});

/** A store with one product, one in-date batch of 60 and an open shift, written directly. */
async function seed() {
  const t = await createTestApp();
  const { app, db } = t;
  const { branchId, deviceId, userId } = app.session;
  const product = await createProduct(app, tabletInput());
  const { batchId } = await addOpeningStock(app, {
    productId: product.id,
    qty: 60,
    batchNo: 'AB1',
    expiryDate: '2027-06-30',
  });
  const unitId = product.units[0]!.id;

  await db
    .insertInto('shift')
    .values({
      id: 'shift1',
      branch_id: branchId,
      device_id: deviceId,
      shift_no: 1,
      business_date: DAY,
      status: 'open',
      opened_by: userId,
      opened_at: AT,
      opening_float: 500000,
      closed_by: null,
      closed_at: null,
      expected_cash: null,
      counted_cash: null,
      variance: null,
      float_left: null,
      count_json: null,
      close_note: null,
      created_at: AT,
      updated_at: AT,
    })
    .execute();

  /** A one-line cash sale of `qty` tablets from `batch`, in `shiftId`. */
  async function sale(
    id: string,
    options: { qty?: number; batch?: string; seq?: number; shiftId?: string; date?: string } = {},
  ) {
    const { qty = 10, batch = batchId, seq = 1, shiftId = 'shift1', date = DAY } = options;
    const amount = qty * 2450;
    await db
      .insertInto('sale')
      .values({
        id,
        branch_id: branchId,
        device_id: deviceId,
        shift_id: shiftId,
        invoice_seq: seq,
        invoice_no: `T1-${String(seq).padStart(6, '0')}`,
        business_date: date,
        user_id: userId,
        line_count: 1,
        gross_total: amount,
        line_discount_total: 0,
        bill_discount_bp: null,
        bill_discount: 0,
        subtotal: amount,
        rounding: 0,
        total: amount,
        tax_total: 0,
        change_given: 0,
        cost_total: null,
        rx_check: 'none',
        approved_by: null,
        created_at: AT,
      })
      .execute();
    await db
      .insertInto('sale_line')
      .values({
        id: `${id}-l1`,
        sale_id: id,
        line_no: 1,
        product_id: product.id,
        unit_id: unitId,
        description: 'Panadol 500mg',
        qty,
        qty_text: `${qty} Tablets`,
        price_amount: 73500,
        price_qty: 30,
        price_source: 'catalog',
        price_reason: null,
        catalog_amount: 73500,
        catalog_qty: 30,
        gross: amount,
        discount_source: 'none',
        line_discount_bp: null,
        line_discount: 0,
        bill_discount_share: 0,
        net: amount,
        tax_class_id: null,
        tax_rate_bp: 0,
        tax: 0,
        cost: null,
        above_mrp: 0,
        rx_required: 0,
        controlled_schedule: null,
        approved_by: null,
        created_at: AT,
      })
      .execute();
    await db
      .insertInto('stock_movement')
      .values({
        id: `${id}-m1`,
        branch_id: branchId,
        device_id: deviceId,
        product_id: product.id,
        batch_id: batch,
        qty: -qty,
        kind: 'sale',
        ref_type: 'sale',
        ref_id: id,
        reason: null,
        user_id: userId,
        created_at: AT,
      })
      .execute();
    const frozen = await db
      .selectFrom('batch')
      .select(['batch_no', 'expiry_date'])
      .where('id', '=', batch)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('sale_line_batch')
      .values({
        id: `${id}-a1`,
        sale_id: id,
        sale_line_id: `${id}-l1`,
        batch_id: batch,
        movement_id: `${id}-m1`,
        qty,
        pick: 'fefo',
        stock_before: 60,
        batch_no: frozen.batch_no,
        expiry_date: frozen.expiry_date,
        cost: null,
        mrp: null,
        created_at: AT,
      })
      .execute();
    await db
      .insertInto('payment')
      .values(payment({ id: `${id}-p1`, sale_id: id, doc_id: id, amount }))
      .execute();
  }

  function payment(row: { id: string; sale_id: string; doc_id: string; amount: number }) {
    return {
      branch_id: branchId,
      device_id: deviceId,
      shift_id: 'shift1',
      doc_type: 'sale' as 'sale' | 'void' | 'return',
      method: 'cash' as 'cash' | 'card' | 'wallet' | 'khata',
      wallet_provider: null as 'jazzcash' | null,
      reference: null as string | null,
      tendered: null as number | null,
      change_given: null as number | null,
      user_id: userId,
      created_at: AT,
      ...row,
    };
  }

  async function saleReturn(id: string, saleId: string, qty: number, seq = 1) {
    const refund = qty * 2450;
    await db
      .insertInto('sale_return')
      .values({
        id,
        sale_id: saleId,
        branch_id: branchId,
        device_id: deviceId,
        shift_id: 'shift1',
        return_seq: seq,
        return_no: `T1-R${String(seq).padStart(6, '0')}`,
        business_date: DAY,
        user_id: userId,
        approved_by: null,
        reason: 'wrong_item',
        note: null,
        refund_net: refund,
        tax_total: 0,
        rounding: 0,
        refund_total: refund,
        cost_total: null,
        created_at: AT,
      })
      .execute();
    await db
      .insertInto('sale_return_line')
      .values({
        id: `${id}-l1`,
        return_id: id,
        sale_line_id: `${saleId}-l1`,
        sale_line_batch_id: `${saleId}-a1`,
        batch_id: batchId,
        qty,
        refund,
        tax: 0,
        cost: null,
        restock: 0,
        movement_id: null,
        created_at: AT,
      })
      .execute();
  }

  async function saleVoid(id: string, saleId: string, shiftId = 'shift1') {
    await db
      .insertInto('sale_void')
      .values({
        id,
        sale_id: saleId,
        branch_id: branchId,
        device_id: deviceId,
        shift_id: shiftId,
        user_id: userId,
        approved_by: null,
        reason: 'Rang up twice',
        created_at: AT,
      })
      .execute();
  }

  return { ...t, product, batchId, sale, payment, saleReturn, saleVoid };
}

async function count(db: Db, table: string): Promise<number> {
  const result = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql.table(table)}`.execute(
    db,
  );
  return result.rows[0]!.n;
}

describe('0002-checkout guards', () => {
  it('keep every document table append-only', async () => {
    const s = await seed();
    await s.sale('s1');
    await s.saleReturn('r1', 's1', 2);
    await s.sale('s2', { seq: 2 });
    await s.saleVoid('v1', 's2');
    await s.db
      .insertInto('sale_prescription')
      .values({
        id: 'rx1',
        sale_id: 's1',
        patient_name: 'Ali',
        patient_phone: null,
        prescriber_name: 'Dr Khan',
        prescriber_reg_no: null,
        rx_date: null,
        rx_ref: null,
        dispensed_by: s.app.session.userId,
        created_at: AT,
      })
      .execute();
    await s.db
      .insertInto('cash_movement')
      .values({
        id: 'c1',
        branch_id: s.app.session.branchId,
        device_id: s.app.session.deviceId,
        shift_id: 'shift1',
        kind: 'pay_out',
        category: 'expense',
        amount: -15000,
        note: 'Tea',
        user_id: s.app.session.userId,
        approved_by: null,
        created_at: AT,
      })
      .execute();

    const tables = [
      'cash_movement',
      'sale',
      'sale_line',
      'sale_line_batch',
      'sale_prescription',
      'sale_void',
      'sale_return',
      'sale_return_line',
      'payment',
    ];
    for (const table of tables) {
      expect(await count(s.db, table), table).toBeGreaterThan(0);
      await expect(
        sql`UPDATE ${sql.table(table)} SET created_at = created_at`.execute(s.db),
        table,
      ).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM ${sql.table(table)}`.execute(s.db), table).rejects.toThrow(
        /append-only/,
      );
    }
  });

  it('allow one open shift per till, and a closed shift never changes', async () => {
    const s = await seed();
    const { branchId, deviceId, userId } = s.app.session;
    await expect(
      sql`INSERT INTO shift (id, branch_id, device_id, shift_no, business_date, status, opened_by,
            opened_at, opening_float, created_at, updated_at)
          VALUES ('shift2', ${branchId}, ${deviceId}, 2, ${DAY}, 'open', ${userId}, ${AT}, 0,
            ${AT}, ${AT})`.execute(s.db),
    ).rejects.toThrow(/UNIQUE/);

    // How the shift opened can't be rewritten.
    await expect(
      sql`UPDATE shift SET opening_float = 0 WHERE id = 'shift1'`.execute(s.db),
    ).rejects.toThrow(/cannot change/);

    // The variance must be counted − expected.
    const close = (variance: number) =>
      sql`UPDATE shift SET status = 'closed', closed_by = ${userId}, closed_at = ${AT},
            expected_cash = 557500, counted_cash = 557000, variance = ${variance},
            float_left = 500000
          WHERE id = 'shift1'`.execute(s.db);
    await expect(close(500)).rejects.toThrow(/CHECK/);
    await close(-500);

    await expect(
      sql`UPDATE shift SET close_note = 'later' WHERE id = 'shift1'`.execute(s.db),
    ).rejects.toThrow(/cannot change/);
    await expect(sql`DELETE FROM shift`.execute(s.db)).rejects.toThrow(/never deleted/);
  });

  it('require sale totals to add up', async () => {
    const s = await seed();
    await s.sale('s1');
    const { branchId, deviceId, userId } = s.app.session;
    const insert = (subtotal: number, total: number) =>
      sql`INSERT INTO sale (id, branch_id, device_id, shift_id, invoice_seq, invoice_no,
            business_date, user_id, line_count, gross_total, line_discount_total, bill_discount,
            subtotal, rounding, total, tax_total, change_given, rx_check, created_at)
          VALUES ('bad', ${branchId}, ${deviceId}, 'shift1', 9, 'T1-000009', ${DAY}, ${userId},
            1, 10000, 500, 0, ${subtotal}, -50, ${total}, 0, 0, 'none', ${AT})`.execute(s.db);
    await expect(insert(10000, 9950)).rejects.toThrow(/CHECK/);
    await expect(insert(9500, 9500)).rejects.toThrow(/CHECK/);
    await insert(9500, 9450);
    // Invoice numbers are unique per till.
    await expect(
      sql`INSERT INTO sale SELECT 'dup', branch_id, device_id, shift_id, invoice_seq, invoice_no,
            business_date, user_id, line_count, gross_total, line_discount_total,
            bill_discount_bp, bill_discount, subtotal, rounding, total, tax_total, change_given,
            cost_total, rx_check, approved_by, created_at
          FROM sale WHERE id = 's1'`.execute(s.db),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('refuse to sell from a batch that had expired on the sale date', async () => {
    const s = await seed();
    const { batchId: expired } = await addOpeningStock(s.app, {
      productId: s.product.id,
      qty: 30,
      batchNo: 'OLD1',
      expiryDate: '2026-09-30',
    });
    await expect(s.sale('s1', { batch: expired })).rejects.toThrow(/Expired stock/);
    // The same batch was fine on a sale dated before it expired (e.g. replayed history).
    await s.sale('s2', { batch: expired, date: '2026-09-30', seq: 2 });
  });

  it('refuse returning more than was sold from a batch', async () => {
    const s = await seed();
    await s.sale('s1', { qty: 10 });
    await s.saleReturn('r1', 's1', 6, 1);
    await expect(s.saleReturn('r2', 's1', 5, 2)).rejects.toThrow(/more than was sold/);
    await s.saleReturn('r3', 's1', 4, 3);
  });

  it('refuse a void after a return, a return after a void, and a void from another shift', async () => {
    const s = await seed();
    await s.sale('s1');
    await s.saleReturn('r1', 's1', 1);
    await expect(s.saleVoid('v1', 's1')).rejects.toThrow(/no returns/);

    await s.sale('s2', { seq: 2 });
    await s.saleVoid('v2', 's2');
    await expect(s.saleVoid('v3', 's2')).rejects.toThrow(/UNIQUE/);
    await expect(s.saleReturn('r2', 's2', 1, 2)).rejects.toThrow(/voided sale/);

    // Close shift 1 and open shift 2: a sale from shift 1 can't be voided in shift 2.
    await s.sale('s3', { seq: 3 });
    const { branchId, deviceId, userId } = s.app.session;
    await sql`UPDATE shift SET status = 'closed', closed_by = ${userId}, closed_at = ${AT},
                expected_cash = 0, counted_cash = 0, variance = 0, float_left = 0
              WHERE id = 'shift1'`.execute(s.db);
    await sql`INSERT INTO shift (id, branch_id, device_id, shift_no, business_date, status,
                opened_by, opened_at, opening_float, created_at, updated_at)
              VALUES ('shift2', ${branchId}, ${deviceId}, 2, ${DAY}, 'open', ${userId}, ${AT}, 0,
                ${AT}, ${AT})`.execute(s.db);
    await expect(s.saleVoid('v4', 's3', 'shift2')).rejects.toThrow(/same shift/);
  });

  it('check payment signs and wallet references', async () => {
    const s = await seed();
    await s.sale('s1');
    const pay = (row: Partial<ReturnType<typeof s.payment>> & { id: string }) =>
      s.db
        .insertInto('payment')
        .values({ ...s.payment({ id: row.id, sale_id: 's1', doc_id: 's1', amount: 100 }), ...row })
        .execute();

    // A sale payment is money in; a void or return payment is money out.
    await expect(pay({ id: 'p-neg', amount: -100 })).rejects.toThrow(/CHECK/);
    await expect(pay({ id: 'p-void', doc_type: 'void', doc_id: 'v', amount: 100 })).rejects.toThrow(
      /CHECK/,
    );
    await pay({ id: 'p-void-ok', doc_type: 'void', doc_id: 'v', amount: -100 });

    // A wallet sale payment needs a reference of at least 4 characters, and NULL is no reference.
    const wallet = { method: 'wallet' as const, wallet_provider: 'jazzcash' as const };
    await expect(pay({ id: 'w-null', ...wallet, reference: null })).rejects.toThrow(/CHECK/);
    await expect(pay({ id: 'w-short', ...wallet, reference: ' 12 ' })).rejects.toThrow(/CHECK/);
    await expect(pay({ id: 'w-noprov', method: 'wallet', reference: '81726354' })).rejects.toThrow(
      /CHECK/,
    );
    await pay({ id: 'w-ok', ...wallet, reference: '81726354' });

    // Cash: kept = tendered − change.
    await expect(
      pay({ id: 'c-bad', amount: 96500, tendered: 100000, change_given: 4000 }),
    ).rejects.toThrow(/CHECK/);
    await pay({ id: 'c-ok', amount: 96500, tendered: 100000, change_given: 3500 });
  });

  it('allow one placeholder batch per product', async () => {
    const s = await seed();
    const placeholder = (id: string) =>
      sql`INSERT INTO batch (id, product_id, batch_no, pack_qty, source, is_placeholder,
            created_at, updated_at)
          VALUES (${id}, ${s.product.id}, '', 30, 'adjustment', 1, ${AT}, ${AT})`.execute(s.db);
    await placeholder('ph1');
    await expect(placeholder('ph2')).rejects.toThrow(/UNIQUE/);
  });

  it('keep one active draft per till, and approvals go with their draft', async () => {
    const s = await seed();
    const { deviceId, userId } = s.app.session;
    const draft = (id: string, status: 'active' | 'held') =>
      sql`INSERT INTO sale_draft (id, device_id, user_id, status, cart_json, line_count, total,
            created_at, updated_at, held_at)
          VALUES (${id}, ${deviceId}, ${userId}, ${status}, '{}', 0, 0, ${AT}, ${AT},
            ${status === 'held' ? AT : null})`.execute(s.db);
    await draft('d1', 'active');
    await expect(draft('d2', 'active')).rejects.toThrow(/UNIQUE/);
    await draft('d3', 'held');
    await expect(
      sql`INSERT INTO sale_draft (id, device_id, user_id, status, cart_json, line_count, total,
            created_at, updated_at)
          VALUES ('d4', ${deviceId}, ${userId}, 'held', '{}', 0, 0, ${AT}, ${AT})`.execute(s.db),
    ).rejects.toThrow(/CHECK/);

    const pharmacist = 'p1';
    await sql`INSERT INTO app_user (id, name, role, is_active, created_at, updated_at)
              VALUES (${pharmacist}, 'Pharmacist', 'pharmacist', 1, ${AT}, ${AT})`.execute(s.db);
    const approve = (id: string, kind: string, bp: number | null, approver: string) =>
      sql`INSERT INTO draft_approval (id, draft_id, kind, line_key, scope_json, approved_bp,
            requested_by, approver_id, created_at)
          VALUES (${id}, 'd1', ${kind}, 'k1', '{}', ${bp}, ${userId}, ${approver}, ${AT})`.execute(
        s.db,
      );
    // A discount approval says how much; nobody approves their own sale.
    await expect(approve('a0', 'sale.discount', null, pharmacist)).rejects.toThrow(/CHECK/);
    await expect(approve('a0', 'sale.discount', 1180, userId)).rejects.toThrow(/CHECK/);
    await approve('a1', 'sale.discount', 1180, pharmacist);
    // Asking again for the same line replaces, never adds.
    await expect(approve('a2', 'sale.discount', 1500, pharmacist)).rejects.toThrow(/UNIQUE/);
    await approve('a3', 'sale.controlled', null, pharmacist);
    await sql`DELETE FROM sale_draft WHERE id = 'd1'`.execute(s.db);
    expect(await count(s.db, 'draft_approval')).toBe(0);
  });
});
