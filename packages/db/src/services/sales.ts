import {
  AppError,
  formatMoney,
  parseInvoiceQuery,
  type IsoDate,
  type Money,
  type PaymentMethod,
  type WalletProvider,
} from '@app/core';
import { z } from 'zod';
import { timestamp, type AppContext } from '../context';
import type { Db } from '../executor';
import { META, setMeta } from '../meta';
import type { BatchPick } from '../schema';
import { requiredText } from '../validation';
import { audit, insertRow, type Tx } from '../writes';
import {
  assertClockTx,
  authorizeTx,
  bumpClockTx,
  getOpenShiftTx,
  noteClockSuspectTx,
  requireOpenShiftTx,
  resolveApproval,
  type ApprovalInput,
} from './guards';
import { getDeviceSettingsTx } from './settings';

export interface SaleLineView {
  id: string;
  lineNo: number;
  productId: string;
  description: string;
  qty: number;
  qtyText: string;
  price: { amount: Money; perQty: number };
  priceSource: 'catalog' | 'mrp' | 'override';
  gross: Money;
  lineDiscount: Money;
  lineDiscountBp: number | null;
  billShare: Money;
  net: Money;
  tax: Money;
  taxRateBp: number;
  aboveMrp: boolean;
  schedule: string | null;
  batches: { batchNo: string; expiryDate: IsoDate | null; qty: number; pick: BatchPick }[];
}

export interface PaymentView {
  docType: 'sale' | 'void' | 'return';
  method: PaymentMethod;
  provider: WalletProvider | null;
  reference: string | null;
  amount: Money;
  tendered: Money | null;
  change: Money | null;
}

export interface SaleView {
  id: string;
  invoiceNo: string;
  businessDate: IsoDate;
  createdAt: string;
  shiftId: string;
  cashier: string;
  grossTotal: Money;
  lineDiscountTotal: Money;
  billDiscount: Money;
  billDiscountBp: number | null;
  subtotal: Money;
  rounding: Money;
  total: Money;
  taxTotal: Money;
  change: Money;
  rxCheck: 'none' | 'seen' | 'not_seen';
  lines: SaleLineView[];
  payments: PaymentView[];
  prescription: { patientName: string; prescriberName: string; dispensedBy: string } | null;
  voided: { at: string; by: string; reason: string; approvedBy: string | null } | null;
  returned: boolean;
  /** Returns against this sale, oldest first. */
  returns: { id: string; returnNo: string; at: string; refundTotal: Money; by: string }[];
  /** Can be voided now: from the open shift, not voided, nothing returned. */
  canVoid: boolean;
  /** Something is left to take back: not voided and not fully returned. */
  canReturn: boolean;
}

async function names(db: Db | Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .selectFrom('app_user')
    .select(['id', 'name'])
    .where('id', 'in', unique)
    .execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function getSale(ctx: AppContext, saleId: string): Promise<SaleView | null> {
  return saleViewTx(ctx.db, ctx, saleId);
}

async function saleViewTx(db: Db | Tx, ctx: AppContext, saleId: string): Promise<SaleView | null> {
  const sale = await db.selectFrom('sale').selectAll().where('id', '=', saleId).executeTakeFirst();
  if (!sale) return null;
  const lines = await db
    .selectFrom('sale_line')
    .selectAll()
    .where('sale_id', '=', saleId)
    .orderBy('line_no')
    .execute();
  const allocations = await db
    .selectFrom('sale_line_batch')
    .select(['sale_line_id', 'batch_no', 'expiry_date', 'qty', 'pick'])
    .where('sale_id', '=', saleId)
    .orderBy('created_at')
    .execute();
  const payments = await db
    .selectFrom('payment')
    .selectAll()
    .where('sale_id', '=', saleId)
    .orderBy('created_at')
    .execute();
  const voided = await db
    .selectFrom('sale_void')
    .selectAll()
    .where('sale_id', '=', saleId)
    .executeTakeFirst();
  const returns = await db
    .selectFrom('sale_return as r')
    .innerJoin('app_user as u', 'u.id', 'r.user_id')
    .select(['r.id', 'r.return_no', 'r.created_at', 'r.refund_total', 'u.name'])
    .where('r.sale_id', '=', saleId)
    .orderBy('r.return_seq')
    .execute();
  const returnedQty = await db
    .selectFrom('sale_return_line as l')
    .innerJoin('sale_return as r', 'r.id', 'l.return_id')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('l.qty'), eb.lit(0)).as('qty'))
    .where('r.sale_id', '=', saleId)
    .executeTakeFirstOrThrow();
  const prescription = await db
    .selectFrom('sale_prescription')
    .selectAll()
    .where('sale_id', '=', saleId)
    .executeTakeFirst();
  const who = await names(db, [
    sale.user_id,
    voided?.user_id ?? null,
    voided?.approved_by ?? null,
    prescription?.dispensed_by ?? null,
  ]);
  const openShift = await getOpenShiftTx(db, ctx);

  return {
    id: sale.id,
    invoiceNo: sale.invoice_no,
    businessDate: sale.business_date,
    createdAt: sale.created_at,
    shiftId: sale.shift_id,
    cashier: who.get(sale.user_id) ?? '',
    grossTotal: sale.gross_total,
    lineDiscountTotal: sale.line_discount_total,
    billDiscount: sale.bill_discount,
    billDiscountBp: sale.bill_discount_bp,
    subtotal: sale.subtotal,
    rounding: sale.rounding,
    total: sale.total,
    taxTotal: sale.tax_total,
    change: sale.change_given,
    rxCheck: sale.rx_check,
    lines: lines.map((l) => ({
      id: l.id,
      lineNo: l.line_no,
      productId: l.product_id,
      description: l.description,
      qty: l.qty,
      qtyText: l.qty_text,
      price: { amount: l.price_amount, perQty: l.price_qty },
      priceSource: l.price_source,
      gross: l.gross,
      lineDiscount: l.line_discount,
      lineDiscountBp: l.line_discount_bp,
      billShare: l.bill_discount_share,
      net: l.net,
      tax: l.tax,
      taxRateBp: l.tax_rate_bp,
      aboveMrp: l.above_mrp === 1,
      schedule: l.controlled_schedule,
      batches: allocations
        .filter((a) => a.sale_line_id === l.id)
        .map((a) => ({ batchNo: a.batch_no, expiryDate: a.expiry_date, qty: a.qty, pick: a.pick })),
    })),
    payments: payments.map((p) => ({
      docType: p.doc_type,
      method: p.method,
      provider: p.wallet_provider,
      reference: p.reference,
      amount: p.amount,
      tendered: p.tendered,
      change: p.change_given,
    })),
    prescription: prescription
      ? {
          patientName: prescription.patient_name,
          prescriberName: prescription.prescriber_name,
          dispensedBy: who.get(prescription.dispensed_by) ?? '',
        }
      : null,
    voided: voided
      ? {
          at: voided.created_at,
          by: who.get(voided.user_id) ?? '',
          reason: voided.reason,
          approvedBy: voided.approved_by ? (who.get(voided.approved_by) ?? '') : null,
        }
      : null,
    returned: returns.length > 0,
    returns: returns.map((r) => ({
      id: r.id,
      returnNo: r.return_no,
      at: r.created_at,
      refundTotal: r.refund_total,
      by: r.name,
    })),
    canVoid: !voided && returns.length === 0 && openShift?.id === sale.shift_id,
    canReturn: !voided && Number(returnedQty.qty) < lines.reduce((s, l) => s + l.qty, 0),
  };
}

export interface SaleListRow {
  id: string;
  invoiceNo: string;
  createdAt: string;
  total: Money;
  lineCount: number;
  cashier: string;
  voided: boolean;
  /** Some of it was taken back. */
  returned: boolean;
  methods: PaymentMethod[];
}

const listSchema = z.object({
  shiftId: z.string().nullish(),
  date: z.string().nullish(),
  query: z.string().trim().nullish(),
  limit: z.number().int().min(1).max(500).default(100),
});

/** Sales on this till, newest first: one shift, one date, or an invoice number search. */
export async function listSales(
  ctx: AppContext,
  input: z.input<typeof listSchema> = {},
): Promise<SaleListRow[]> {
  const options = listSchema.parse(input);
  let q = ctx.db
    .selectFrom('sale as s')
    .innerJoin('app_user as u', 'u.id', 's.user_id')
    .leftJoin('sale_void as v', 'v.sale_id', 's.id')
    .select([
      's.id',
      's.invoice_no',
      's.created_at',
      's.total',
      's.line_count',
      'u.name',
      'v.id as void_id',
      (eb) =>
        eb
          .exists(
            eb.selectFrom('sale_return as r').select('r.id').whereRef('r.sale_id', '=', 's.id'),
          )
          .as('has_return'),
    ])
    .where('s.device_id', '=', ctx.session.deviceId)
    .orderBy('s.invoice_seq', 'desc')
    .limit(options.limit);
  if (options.shiftId) q = q.where('s.shift_id', '=', options.shiftId);
  if (options.date) q = q.where('s.business_date', '=', options.date);
  if (options.query) {
    const parsed = parseInvoiceQuery(options.query);
    if (!parsed || parsed.isReturn) return [];
    q = q.where('s.invoice_seq', '=', parsed.seq);
  }
  const rows = await q.execute();
  const ids = rows.map((r) => r.id);
  const methods =
    ids.length === 0
      ? []
      : await ctx.db
          .selectFrom('payment')
          .select(['sale_id', 'method'])
          .where('sale_id', 'in', ids)
          .where('doc_type', '=', 'sale')
          .execute();
  return rows.map((r) => ({
    id: r.id,
    invoiceNo: r.invoice_no,
    createdAt: r.created_at,
    total: r.total,
    lineCount: r.line_count,
    cashier: r.name,
    voided: r.void_id !== null,
    returned: !!r.has_return,
    methods: [...new Set(methods.filter((m) => m.sale_id === r.id).map((m) => m.method))].sort(),
  }));
}

/** Finds a sale from what staff type or scan: "123", "T1-000123", "T1000123". */
export async function findSale(ctx: AppContext, text: string): Promise<SaleView | null> {
  const parsed = parseInvoiceQuery(text);
  if (!parsed || parsed.isReturn) return null;
  const device = await ctx.db
    .selectFrom('device')
    .select(['id', 'code'])
    .where('id', '=', ctx.session.deviceId)
    .executeTakeFirstOrThrow();
  if (parsed.tillCode && parsed.tillCode !== device.code) return null;
  const row = await ctx.db
    .selectFrom('sale')
    .select('id')
    .where('device_id', '=', device.id)
    .where('invoice_seq', '=', parsed.seq)
    .executeTakeFirst();
  return row ? getSale(ctx, row.id) : null;
}

export async function getLastSale(ctx: AppContext): Promise<SaleView | null> {
  const row = await ctx.db
    .selectFrom('sale')
    .select('id')
    .where('device_id', '=', ctx.session.deviceId)
    .orderBy('invoice_seq', 'desc')
    .executeTakeFirst();
  return row ? getSale(ctx, row.id) : null;
}

/** Logs a reprint (the receipt is then marked REPRINT). */
export async function recordReprint(ctx: AppContext, saleId: string): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'sale.reprint');
    const sale = await trx
      .selectFrom('sale')
      .select(['id', 'invoice_no'])
      .where('id', '=', saleId)
      .executeTakeFirst();
    if (!sale) throw new AppError('NOT_FOUND', 'Sale not found');
    await audit(trx, ctx, {
      action: 'sale.reprint',
      entityType: 'sale',
      entityId: sale.id,
      after: { invoiceNo: sale.invoice_no },
    });
  });
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

const voidSchema = z.object({
  saleId: z.string().min(1),
  reason: requiredText(200, 'Say why the sale is being voided'),
  approval: z.object({ userId: z.string(), pin: z.string() }).nullish(),
});

export interface VoidResult {
  voidId: string;
  invoiceNo: string;
  /** Cash to hand back from the drawer. */
  cashToGiveBack: Money;
  /** Card and wallet payments to reverse on the terminal or app. */
  nonCash: {
    method: PaymentMethod;
    provider: WalletProvider | null;
    reference: string | null;
    amount: Money;
  }[];
  openDrawer: boolean;
}

/**
 * Cancels a sale from the current shift: puts the stock back into the same batches and
 * pays back every payment, all as new records (the sale itself never changes). A sale from
 * a closed shift, or with items returned, needs a return instead.
 */
export async function voidSale(
  ctx: AppContext,
  input: { saleId: string; reason: string; approval?: ApprovalInput | null },
): Promise<VoidResult> {
  const data = voidSchema.parse(input);
  const approval = await resolveApproval(ctx, data.approval, 'sale.void');
  const deviceSettings = await getDeviceSettingsTx(ctx.db);
  return ctx.db.transaction().execute(async (trx) => {
    const { approvedBy } = await authorizeTx(trx, ctx, 'sale.void', approval);
    const clock = await assertClockTx(trx, ctx);
    const shift = await requireOpenShiftTx(trx, ctx);
    const sale = await trx
      .selectFrom('sale')
      .selectAll()
      .where('id', '=', data.saleId)
      .executeTakeFirst();
    if (!sale) throw new AppError('NOT_FOUND', 'Sale not found');
    if (sale.shift_id !== shift.id) {
      throw new AppError('INVALID_STATE', 'This sale is from a closed shift — use a return');
    }
    const already = await trx
      .selectFrom('sale_void')
      .select('id')
      .where('sale_id', '=', sale.id)
      .executeTakeFirst();
    if (already) throw new AppError('INVALID_STATE', 'This sale is already voided');
    const returned = await trx
      .selectFrom('sale_return')
      .select('id')
      .where('sale_id', '=', sale.id)
      .executeTakeFirst();
    if (returned) {
      throw new AppError('INVALID_STATE', 'Part of this sale was returned — use a return');
    }

    const now = timestamp(ctx);
    const { branchId, deviceId, userId } = ctx.session;
    const voidId = ctx.newId();
    await insertRow(trx, now, 'sale_void', {
      id: voidId,
      sale_id: sale.id,
      branch_id: branchId,
      device_id: deviceId,
      shift_id: shift.id,
      user_id: userId,
      approved_by: approvedBy,
      reason: data.reason,
      created_at: now,
    });

    const allocations = await trx
      .selectFrom('sale_line_batch as a')
      .innerJoin('batch as b', 'b.id', 'a.batch_id')
      .select(['a.batch_id', 'a.qty', 'b.product_id'])
      .where('a.sale_id', '=', sale.id)
      .orderBy('a.created_at')
      .execute();
    for (const a of allocations) {
      await insertRow(trx, now, 'stock_movement', {
        id: ctx.newId(),
        branch_id: branchId,
        device_id: deviceId,
        product_id: a.product_id,
        batch_id: a.batch_id,
        qty: a.qty,
        kind: 'sale_return',
        ref_type: 'sale_void',
        ref_id: voidId,
        reason: data.reason,
        user_id: userId,
        created_at: now,
      });
    }

    const payments = await trx
      .selectFrom('payment')
      .selectAll()
      .where('sale_id', '=', sale.id)
      .where('doc_type', '=', 'sale')
      .orderBy('created_at')
      .execute();
    let cash = 0;
    const nonCash: VoidResult['nonCash'] = [];
    for (const p of payments) {
      await insertRow(trx, now, 'payment', {
        id: ctx.newId(),
        branch_id: branchId,
        device_id: deviceId,
        shift_id: shift.id,
        sale_id: sale.id,
        doc_type: 'void',
        doc_id: voidId,
        method: p.method,
        wallet_provider: p.wallet_provider,
        reference: p.reference,
        amount: -p.amount,
        tendered: null,
        change_given: null,
        user_id: userId,
        created_at: now,
      });
      if (p.method === 'cash') cash += p.amount;
      else {
        nonCash.push({
          method: p.method,
          provider: p.wallet_provider,
          reference: p.reference,
          amount: p.amount,
        });
      }
    }

    await audit(trx, ctx, {
      action: 'sale.void',
      entityType: 'sale',
      entityId: sale.id,
      after: { invoiceNo: sale.invoice_no, total: sale.total, voidId },
      reason: data.reason,
      approvedBy,
    });
    await noteClockSuspectTx(trx, ctx, shift.id, clock);
    if (deviceSettings.printer.mode !== 'off' && deviceSettings.printer.autoPrint) {
      await setMeta(
        trx,
        META.lastReceipt,
        JSON.stringify({ docType: 'void', docId: voidId, status: 'pending' }),
      );
    }
    await bumpClockTx(trx, ctx);
    return {
      voidId,
      invoiceNo: sale.invoice_no,
      cashToGiveBack: cash,
      nonCash,
      openDrawer: cash > 0,
    };
  });
}

/** "Give back Rs 965.00 cash; reverse the Rs 1,000.00 card payment (4417)". For voids and returns. */
export function describeRefund(result: Pick<VoidResult, 'cashToGiveBack' | 'nonCash'>): string[] {
  const steps: string[] = [];
  if (result.cashToGiveBack > 0) steps.push(`Give back ${formatMoney(result.cashToGiveBack)} cash`);
  for (const p of result.nonCash) {
    const what = p.method === 'wallet' ? (p.provider ?? 'wallet') : p.method;
    steps.push(
      `Reverse the ${formatMoney(p.amount)} ${what} payment${p.reference ? ` (${p.reference})` : ''}`,
    );
  }
  return steps;
}
