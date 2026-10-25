import {
  AppError,
  formatQty,
  priceForQty,
  type IsoDate,
  type Money,
  type PaymentMethod,
  type WalletProvider,
} from '@app/core';
import type { AppContext } from '../context';
import type { ReturnReason } from '../schema';
import { getStoreSettingsTx } from './settings';

/** Everything a sale receipt shows, as plain data. The till turns it into a receipt layout. */
export interface SaleReceiptData {
  store: {
    name: string;
    address: string | null;
    phone: string | null;
    ntn: string | null;
    drugLicenseNo: string | null;
  };
  tillCode: string;
  invoiceNo: string;
  /** ISO time of the sale. */
  at: string;
  cashier: string;
  copy: 'original' | 'reprint';
  voided: boolean;
  lines: {
    no: number;
    description: string;
    qtyText: string;
    /** Price of one of the units the line was entered in, e.g. Rs 245.00 per Strip. */
    rate: { amount: Money; unit: string };
    gross: Money;
    discount: Money;
    discountBp: number | null;
    batches: { batchNo: string; expiryDate: IsoDate | null }[];
  }[];
  itemsTotal: Money;
  itemDiscounts: Money;
  billDiscount: Money;
  billDiscountBp: number | null;
  rounding: Money;
  total: Money;
  taxByRate: { rateBp: number; tax: Money }[];
  payments: {
    method: PaymentMethod;
    provider: WalletProvider | null;
    reference: string | null;
    amount: Money;
    tendered: Money | null;
  }[];
  change: Money;
  /** Discounts given, shown as "You saved". */
  saved: Money;
  prescription: { patientName: string; prescriberName: string } | null;
  options: { showBatch: boolean; showSavings: boolean; footer: string[] };
}

export async function getSaleReceiptData(
  ctx: AppContext,
  saleId: string,
  options: { copy?: 'original' | 'reprint' } = {},
): Promise<SaleReceiptData> {
  const db = ctx.db;
  const sale = await db
    .selectFrom('sale as s')
    .innerJoin('branch as b', 'b.id', 's.branch_id')
    .innerJoin('device as d', 'd.id', 's.device_id')
    .innerJoin('app_user as u', 'u.id', 's.user_id')
    .selectAll('s')
    .select([
      'b.name as store_name',
      'b.address',
      'b.phone',
      'b.ntn',
      'b.drug_license_no',
      'd.code as till_code',
      'u.name as cashier',
    ])
    .where('s.id', '=', saleId)
    .executeTakeFirst();
  if (!sale) throw new AppError('NOT_FOUND', 'Sale not found');
  const lines = await db
    .selectFrom('sale_line as l')
    .innerJoin('product_unit as pu', 'pu.id', 'l.unit_id')
    .selectAll('l')
    .select(['pu.name as unit_name', 'pu.qty as unit_qty'])
    .where('l.sale_id', '=', saleId)
    .orderBy('l.line_no')
    .execute();
  const allocations = await db
    .selectFrom('sale_line_batch')
    .select(['sale_line_id', 'batch_no', 'expiry_date', 'pick'])
    .where('sale_id', '=', saleId)
    .orderBy('created_at')
    .execute();
  const payments = await db
    .selectFrom('payment')
    .selectAll()
    .where('sale_id', '=', saleId)
    .where('doc_type', '=', 'sale')
    .orderBy('created_at')
    .execute();
  const voided = await db
    .selectFrom('sale_void')
    .select('id')
    .where('sale_id', '=', saleId)
    .executeTakeFirst();
  const rx = await db
    .selectFrom('sale_prescription')
    .select(['patient_name', 'prescriber_name'])
    .where('sale_id', '=', saleId)
    .executeTakeFirst();
  const settings = await getStoreSettingsTx(db, ctx.session.branchId);

  const taxByRate = new Map<number, Money>();
  for (const l of lines) {
    if (l.tax_rate_bp > 0)
      taxByRate.set(l.tax_rate_bp, (taxByRate.get(l.tax_rate_bp) ?? 0) + l.tax);
  }
  return {
    store: {
      name: sale.store_name,
      address: sale.address,
      phone: sale.phone,
      ntn: sale.ntn,
      drugLicenseNo: sale.drug_license_no,
    },
    tillCode: sale.till_code,
    invoiceNo: sale.invoice_no,
    at: sale.created_at,
    cashier: sale.cashier,
    copy: options.copy ?? 'original',
    voided: !!voided,
    lines: lines.map((l) => ({
      no: l.line_no,
      description: l.description,
      qtyText: l.qty_text,
      rate: {
        amount: priceForQty({ amount: l.price_amount, perQty: l.price_qty }, l.unit_qty),
        unit: l.unit_name,
      },
      gross: l.gross,
      discount: l.line_discount,
      discountBp: l.line_discount_bp,
      batches: allocations
        .filter((a) => a.sale_line_id === l.id && a.pick !== 'unrecorded')
        .map((a) => ({ batchNo: a.batch_no, expiryDate: a.expiry_date })),
    })),
    itemsTotal: sale.gross_total,
    itemDiscounts: sale.line_discount_total,
    billDiscount: sale.bill_discount,
    billDiscountBp: sale.bill_discount_bp,
    rounding: sale.rounding,
    total: sale.total,
    taxByRate: [...taxByRate.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rateBp, tax]) => ({ rateBp, tax })),
    payments: payments.map((p) => ({
      method: p.method,
      provider: p.wallet_provider,
      reference: p.reference,
      amount: p.amount,
      tendered: p.tendered,
    })),
    change: sale.change_given,
    saved: sale.line_discount_total + sale.bill_discount,
    prescription: rx ? { patientName: rx.patient_name, prescriberName: rx.prescriber_name } : null,
    options: settings.receipt,
  };
}

/** Everything a return receipt shows, as plain data. */
export interface ReturnReceiptData {
  store: SaleReceiptData['store'];
  tillCode: string;
  returnNo: string;
  invoiceNo: string;
  /** ISO time of the return. */
  at: string;
  cashier: string;
  approvedBy: string | null;
  copy: 'original' | 'reprint';
  reason: ReturnReason;
  note: string | null;
  lines: {
    description: string;
    /** What came back, e.g. "1 Strip, 2 Tablets". */
    qtyText: string;
    refund: Money;
    batches: { batchNo: string; expiryDate: IsoDate | null }[];
  }[];
  refundNet: Money;
  rounding: Money;
  refundTotal: Money;
  taxByRate: { rateBp: number; tax: Money }[];
  /** How the refund was paid back (positive amounts). */
  refunds: {
    method: PaymentMethod;
    provider: WalletProvider | null;
    reference: string | null;
    amount: Money;
  }[];
  options: SaleReceiptData['options'];
}

export async function getReturnReceiptData(
  ctx: AppContext,
  returnId: string,
  options: { copy?: 'original' | 'reprint' } = {},
): Promise<ReturnReceiptData> {
  const db = ctx.db;
  const ret = await db
    .selectFrom('sale_return as r')
    .innerJoin('sale as s', 's.id', 'r.sale_id')
    .innerJoin('branch as b', 'b.id', 'r.branch_id')
    .innerJoin('device as d', 'd.id', 'r.device_id')
    .innerJoin('app_user as u', 'u.id', 'r.user_id')
    .leftJoin('app_user as a', 'a.id', 'r.approved_by')
    .selectAll('r')
    .select([
      's.invoice_no',
      'b.name as store_name',
      'b.address',
      'b.phone',
      'b.ntn',
      'b.drug_license_no',
      'd.code as till_code',
      'u.name as cashier',
      'a.name as approver',
    ])
    .where('r.id', '=', returnId)
    .executeTakeFirst();
  if (!ret) throw new AppError('NOT_FOUND', 'Return not found');
  const pieces = await db
    .selectFrom('sale_return_line as rl')
    .innerJoin('sale_line as l', 'l.id', 'rl.sale_line_id')
    .innerJoin('sale_line_batch as a', 'a.id', 'rl.sale_line_batch_id')
    .select([
      'rl.sale_line_id',
      'rl.qty',
      'rl.refund',
      'l.line_no',
      'l.product_id',
      'l.description',
      'l.tax_rate_bp',
      'rl.tax',
      'a.batch_no',
      'a.expiry_date',
      'a.pick',
    ])
    .where('rl.return_id', '=', returnId)
    .orderBy('l.line_no')
    .execute();
  const productIds = [...new Set(pieces.map((p) => p.product_id))];
  const units =
    productIds.length === 0
      ? []
      : await db
          .selectFrom('product_unit')
          .select(['product_id', 'name', 'qty'])
          .where('product_id', 'in', productIds)
          .where('is_active', '=', 1)
          .execute();
  const payments = await db
    .selectFrom('payment')
    .select(['method', 'wallet_provider', 'reference', 'amount'])
    .where('doc_type', '=', 'return')
    .where('doc_id', '=', returnId)
    .orderBy('created_at')
    .execute();
  const settings = await getStoreSettingsTx(db, ctx.session.branchId);

  const lines = new Map<
    string,
    ReturnReceiptData['lines'][number] & { qty: number; productId: string }
  >();
  const taxByRate = new Map<number, Money>();
  for (const p of pieces) {
    const line = lines.get(p.sale_line_id) ?? {
      description: p.description,
      qtyText: '',
      refund: 0,
      batches: [],
      qty: 0,
      productId: p.product_id,
    };
    line.qty += p.qty;
    line.refund += p.refund;
    if (p.pick !== 'unrecorded' && !line.batches.some((b) => b.batchNo === p.batch_no)) {
      line.batches.push({ batchNo: p.batch_no, expiryDate: p.expiry_date });
    }
    lines.set(p.sale_line_id, line);
    if (p.tax_rate_bp > 0)
      taxByRate.set(p.tax_rate_bp, (taxByRate.get(p.tax_rate_bp) ?? 0) + p.tax);
  }
  const methodOrder = { cash: 0, card: 1, wallet: 2, khata: 3 } as const;
  return {
    store: {
      name: ret.store_name,
      address: ret.address,
      phone: ret.phone,
      ntn: ret.ntn,
      drugLicenseNo: ret.drug_license_no,
    },
    tillCode: ret.till_code,
    returnNo: ret.return_no,
    invoiceNo: ret.invoice_no,
    at: ret.created_at,
    cashier: ret.cashier,
    approvedBy: ret.approver,
    copy: options.copy ?? 'original',
    reason: ret.reason,
    note: ret.note,
    lines: [...lines.values()].map(({ qty, productId, ...line }) => {
      const mine = units.filter((u) => u.product_id === productId);
      return {
        ...line,
        qtyText: mine.some((u) => u.qty === 1) ? formatQty(qty, mine) : String(qty),
      };
    }),
    refundNet: ret.refund_net,
    rounding: ret.rounding,
    refundTotal: ret.refund_total,
    taxByRate: [...taxByRate.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rateBp, tax]) => ({ rateBp, tax })),
    refunds: payments
      .map((p) => ({
        method: p.method,
        provider: p.wallet_provider,
        reference: p.reference,
        amount: -p.amount,
      }))
      .sort((a, b) => methodOrder[a.method] - methodOrder[b.method]),
    options: settings.receipt,
  };
}
