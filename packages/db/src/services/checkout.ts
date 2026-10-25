import {
  AppError,
  approverPhrase,
  can,
  discountNeedBp,
  displayQty,
  effectiveCapBp,
  expiryStatus,
  formatDocNo,
  formatMoney,
  grantScope,
  normalizeCart,
  rolesThatCan,
  settleTenders,
  WALLET_PROVIDERS,
  type Cart,
  type CartProduct,
  type CartUnit,
  type ExpiryStatus,
  type Grant,
  type GrantKind,
  type IsoDate,
  type Money,
  type PackPrice,
  type RxKind,
  type Tender,
} from '@app/core';
import { z } from 'zod';
import { timestamp, today, type AppContext } from '../context';
import type { Db } from '../executor';
import { META, getMeta, setMeta } from '../meta';
import { audit, insertRow, type Tx } from '../writes';
import { parseCart } from './drafts';
import {
  actorTx,
  assertClockTx,
  authorizeTx,
  bumpClockTx,
  clockMessage,
  clockStateTx,
  expiryTodayTx,
  nextDocSeqTx,
  noteClockSuspectTx,
  requireOpenShiftTx,
  verifyApprover,
} from './guards';
import {
  buildSale,
  loadSaleData,
  type ApprovalNeed,
  type BuiltLine,
  type ExpiryCheck,
  type SaleBuild,
  type SaleWarning,
} from './sale-build';
import { findProductByBarcode } from './search';
import { getDeviceSettingsTx, getStoreSettingsTx } from './settings';

// ---------------------------------------------------------------------------
// What can be sold
// ---------------------------------------------------------------------------

export interface SellableBatch {
  batchId: string;
  batchNo: string;
  expiryDate: IsoDate | null;
  status: ExpiryStatus;
  qty: number;
  /** MRP as printed, per pack of `perQty` base units. */
  mrp: PackPrice | null;
  /** Only for staff who may see costs. */
  cost: PackPrice | null;
  placeholder: boolean;
}

export interface SellableItem {
  product: CartProduct;
  isActive: boolean;
  rack: string | null;
  /** In-date stock on record, base units. */
  stockQty: number;
  batches: SellableBatch[];
  /** The date expiry was checked against (never earlier than the last record's date). */
  expiryToday: IsoDate;
}

function rxKind(rxRequired: boolean, schedule: string | null): RxKind {
  return schedule ? 'controlled' : rxRequired ? 'required' : 'none';
}

/** A product as the sale screen adds it, with its batches (expired and empty ones included). */
export async function getSellable(
  ctx: AppContext,
  productId: string,
): Promise<SellableItem | null> {
  const actor = await actorTx(ctx.db, ctx);
  const data = await loadSaleData(ctx.db, ctx.session.branchId, [productId]);
  const product = data.products.get(productId);
  if (!product) return null;
  const extra = await ctx.db
    .selectFrom('product')
    .select('rack')
    .where('id', '=', productId)
    .executeTakeFirstOrThrow();
  const settings = await getStoreSettingsTx(ctx.db, ctx.session.branchId);
  const expiryToday = await expiryTodayTx(ctx.db, ctx);
  const showCost = can(actor.role, 'cost.view');
  const batches = (data.batches.get(productId) ?? [])
    .filter((b) => b.qty !== 0 || b.placeholder)
    .map((b): SellableBatch => ({
      batchId: b.id,
      batchNo: b.batchNo,
      expiryDate: b.expiryDate,
      status: b.placeholder
        ? 'none'
        : expiryStatus(b.expiryDate, expiryToday, settings.saleNearExpiryDays),
      qty: b.qty,
      mrp: b.mrp === null ? null : { amount: b.mrp, perQty: b.packQty },
      cost: showCost && b.cost !== null ? { amount: b.cost, perQty: b.packQty } : null,
      placeholder: b.placeholder,
    }))
    .sort(
      (a, b) =>
        Number(a.placeholder) - Number(b.placeholder) ||
        (a.expiryDate ?? '9999').localeCompare(b.expiryDate ?? '9999'),
    );
  const units: CartUnit[] = product.units.map((u) => ({ ...u }));
  return {
    product: {
      productId: product.id,
      name: product.title,
      units,
      price: product.price,
      allowDiscount: product.allowDiscount,
      taxRateBp: product.taxRateBp,
      rx: rxKind(product.rxRequired, product.schedule),
      schedule: product.schedule,
    },
    isActive: product.isActive,
    rack: extra.rack,
    stockQty: batches
      .filter((b) => !b.placeholder && b.status !== 'expired' && b.qty > 0)
      .reduce((s, b) => s + b.qty, 0),
    batches,
    expiryToday,
  };
}

/** A scanned (or typed) barcode: the product and the pack size the barcode is printed on. */
export async function findByScan(
  ctx: AppContext,
  code: string,
): Promise<{ item: SellableItem; unitId: string } | null> {
  const hit = await findProductByBarcode(ctx, code);
  if (!hit) return null;
  const item = await getSellable(ctx, hit.productId);
  return item ? { item, unitId: hit.unitId } : null;
}

// ---------------------------------------------------------------------------
// Planning (read-only, as the cashier rings up)
// ---------------------------------------------------------------------------

async function grantsTx(db: Db | Tx, draftId: string): Promise<Grant[]> {
  const rows = await db
    .selectFrom('draft_approval')
    .selectAll()
    .where('draft_id', '=', draftId)
    .execute();
  return rows.map((r) => ({
    kind: r.kind,
    lineKey: r.line_key,
    scopeJson: r.scope_json,
    approvedBp: r.approved_bp,
    requestedBy: r.requested_by,
    approverId: r.approver_id,
  }));
}

async function buildFor(db: Db | Tx, ctx: AppContext, cart: Cart): Promise<SaleBuild> {
  const actor = await actorTx(db, ctx);
  const settings = await getStoreSettingsTx(db, ctx.session.branchId);
  const data = await loadSaleData(
    db,
    ctx.session.branchId,
    cart.lines.map((l) => l.productId),
  );
  return buildSale({
    cart,
    data,
    settings,
    expiryToday: await expiryTodayTx(db, ctx),
    actor: { id: actor.id, role: actor.role, canControlled: can(actor.role, 'sale.controlled') },
    grants: await grantsTx(db, cart.id),
  });
}

export interface PlannedPart {
  batchId: string | null;
  batchNo: string;
  expiryDate: IsoDate | null;
  qty: number;
  pick: 'fefo' | 'manual' | 'unrecorded';
  placeholder: boolean;
}

export interface PlannedLine {
  key: string;
  price: PackPrice;
  priceSource: 'catalog' | 'mrp';
  gross: Money;
  lineDiscount: Money;
  billShare: Money;
  net: Money;
  tax: Money;
  parts: PlannedPart[];
  aboveMrp: { mrpPrice: PackPrice; over: Money } | null;
}

export interface SalePlan {
  /** The cart after dropping discounts that no longer fit. */
  cart: Cart;
  lines: PlannedLine[];
  totals: {
    grossTotal: Money;
    lineDiscountTotal: Money;
    billDiscount: Money;
    subtotal: Money;
    rounding: Money;
    total: Money;
    taxTotal: Money;
  } | null;
  fields: Record<string, string>;
  payFields: Record<string, string>;
  notAvailable: string | null;
  confirm: ExpiryCheck[];
  needs: ApprovalNeed[];
  warnings: SaleWarning[];
}

function toPlan(build: SaleBuild): Omit<SalePlan, 'warnings'> & { warnings: SaleWarning[] } {
  const p = build.priced;
  return {
    cart: build.cart,
    lines: build.lines.map((b) => ({
      key: b.key,
      price: b.price,
      priceSource: b.priceSource,
      gross: b.priced?.gross ?? 0,
      lineDiscount: b.priced?.lineDiscount ?? 0,
      billShare: b.priced?.billShare ?? 0,
      net: b.priced?.net ?? 0,
      tax: b.priced?.tax ?? 0,
      parts: b.parts.map((part) => ({
        batchId: part.batchId,
        batchNo: part.batchNo,
        expiryDate: part.expiryDate,
        qty: part.qty,
        pick: part.pick,
        placeholder: part.placeholder,
      })),
      aboveMrp: b.aboveMrp,
    })),
    totals: p
      ? {
          grossTotal: p.grossTotal,
          lineDiscountTotal: p.lineDiscountTotal,
          billDiscount: p.billDiscount,
          subtotal: p.subtotal,
          rounding: p.rounding,
          total: p.total,
          taxTotal: p.taxTotal,
        }
      : null,
    fields: build.fields,
    payFields: build.payFields,
    notAvailable: build.notAvailable,
    confirm: build.confirm,
    needs: build.needs,
    warnings: build.warnings,
  };
}

/** What completing this cart would record now: prices, batches, warnings and approvals. */
export async function planSale(ctx: AppContext, cart: Cart): Promise<SalePlan> {
  const plan = toPlan(await buildFor(ctx.db, ctx, cart));
  const clock = await clockStateTx(ctx.db, ctx);
  if (clock.check.status === 'behind') {
    plan.warnings.push({ kind: 'clock_behind', message: clockMessage(ctx, clock) });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Approvals on the sale in progress
// ---------------------------------------------------------------------------

const grantSchema = z.object({
  draftId: z.string().min(1),
  kind: z.enum(['sale.discount', 'sale.controlled'] as const satisfies readonly GrantKind[]),
  /** The line approved, or '' for the whole bill. */
  lineKey: z.string(),
  userId: z.string().min(1, 'Choose who is approving'),
  pin: z.string('Enter the PIN').trim(),
});

export type GrantApprovalInput = z.input<typeof grantSchema>;

async function activeDraftCart(db: Db | Tx, ctx: AppContext, draftId: string): Promise<Cart> {
  const draft = await db
    .selectFrom('sale_draft')
    .select(['id', 'cart_json'])
    .where('id', '=', draftId)
    .where('device_id', '=', ctx.session.deviceId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!draft) throw new AppError('INVALID_STATE', 'This sale is no longer open');
  const cart = parseCart(draft.cart_json);
  if (!cart) throw new AppError('INVALID_STATE', 'This sale can’t be read. Discard it.');
  return cart;
}

/**
 * A pharmacist or the owner approves something on the saved sale: a discount above the
 * cashier's cap (one line, or the bill) or dispensing controlled drugs. The approval
 * covers exactly the sale as saved; the screen saves it first.
 */
export async function grantApproval(
  ctx: AppContext,
  input: GrantApprovalInput,
): Promise<{ approverName: string; approvedBp: number | null }> {
  const data = grantSchema.parse(input);
  const build = await buildFor(ctx.db, ctx, await activeDraftCart(ctx.db, ctx, data.draftId));
  let need: number | null = null;
  if (data.kind === 'sale.discount') {
    if (!build.priced) throw new AppError('VALIDATION', 'Fix the bill first', build.fields);
    const lines =
      data.lineKey === ''
        ? build.priced.lines
        : build.priced.lines.filter((l) => l.key === data.lineKey);
    if (lines.length === 0)
      throw new AppError('INVALID_STATE', 'That line is no longer in the sale');
    need = Math.max(0, ...lines.map((l) => discountNeedBp(l.lineDiscount + l.billShare, l.gross)));
  }
  const approval = await verifyApprover(
    ctx,
    { userId: data.userId, pin: data.pin },
    data.kind === 'sale.discount' ? { discountBp: need ?? 0 } : data.kind,
  );

  await ctx.db.transaction().execute(async (trx) => {
    const cart = await activeDraftCart(trx, ctx, data.draftId);
    const approver = await trx
      .selectFrom('app_user')
      .select(['role', 'is_active'])
      .where('id', '=', approval.userId)
      .executeTakeFirst();
    const settings = await getStoreSettingsTx(trx, ctx.session.branchId);
    const stillOk =
      !!approver &&
      approver.is_active === 1 &&
      (data.kind === 'sale.discount'
        ? effectiveCapBp(settings.discountCapBp[approver.role], settings.defaultDiscountBp) >=
          (need ?? 0)
        : can(approver.role, data.kind));
    if (!stillOk) throw new AppError('FORBIDDEN', `${approval.name} can’t approve this`);
    const now = timestamp(ctx);
    const scope = grantScope(normalizeCart(cart, settings).cart, data.kind, data.lineKey);
    const row = {
      id: ctx.newId(),
      draft_id: data.draftId,
      kind: data.kind,
      line_key: data.lineKey,
      scope_json: scope,
      approved_bp: need,
      requested_by: ctx.session.userId,
      approver_id: approval.userId,
      created_at: now,
    };
    await trx
      .insertInto('draft_approval')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['draft_id', 'kind', 'line_key']).doUpdateSet({
          scope_json: row.scope_json,
          approved_bp: row.approved_bp,
          requested_by: row.requested_by,
          approver_id: row.approver_id,
          created_at: row.created_at,
        }),
      )
      .execute();
    await audit(trx, ctx, {
      action: 'auth.approval',
      entityType: 'sale_draft',
      entityId: data.draftId,
      after: { kind: data.kind, lineKey: data.lineKey, approvedBp: need },
      approvedBy: approval.userId,
    });
  });
  return { approverName: approval.name, approvedBp: need };
}

// ---------------------------------------------------------------------------
// Completing a sale
// ---------------------------------------------------------------------------

const tenderSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('cash'), tendered: z.number().int() }),
  z.object({
    method: z.literal('card'),
    amount: z.number().int(),
    reference: z.string().trim().max(40).nullish(),
  }),
  z.object({
    method: z.literal('wallet'),
    provider: z.enum(WALLET_PROVIDERS),
    amount: z.number().int(),
    reference: z.string().trim().max(40),
  }),
  z.object({ method: z.literal('khata'), amount: z.number().int() }),
]);

const completeSchema = z.object({
  draftId: z.string().min(1),
  tenders: z.array(tenderSchema).max(10),
  /** The total the screen showed; if prices changed meanwhile the sale is refused. */
  expectedTotal: z.number().int().min(0),
});

export type CompleteSaleInput = z.input<typeof completeSchema>;

export interface CompletedSale {
  saleId: string;
  invoiceNo: string;
  total: Money;
  change: Money;
  /** Cash kept for the sale (tendered − change). */
  cashReceived: Money;
  /** The same sale was completed before (a double Enter, or a retry after a crash). */
  alreadyCompleted: boolean;
  openDrawer: boolean;
}

async function completedView(db: Db | Tx, saleId: string): Promise<CompletedSale | null> {
  const sale = await db
    .selectFrom('sale')
    .select(['id', 'invoice_no', 'total', 'change_given'])
    .where('id', '=', saleId)
    .executeTakeFirst();
  if (!sale) return null;
  const cash = await db
    .selectFrom('payment')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount'), eb.lit(0)).as('cash'))
    .where('sale_id', '=', saleId)
    .where('doc_type', '=', 'sale')
    .where('method', '=', 'cash')
    .executeTakeFirstOrThrow();
  const cashReceived = Number(cash.cash);
  return {
    saleId: sale.id,
    invoiceNo: sale.invoice_no,
    total: sale.total,
    change: sale.change_given,
    cashReceived,
    alreadyCompleted: true,
    openDrawer: cashReceived > 0,
  };
}

const TENDER_PROBLEMS = {
  non_cash_over_total: 'Card and wallet can’t be more than the bill',
  cash_not_needed: 'No cash is needed — the bill is already paid',
  wallet_reference: 'Enter the transaction ID (at least 4 characters)',
  zero_amount: 'Enter an amount',
} as const;

function approvalError(need: ApprovalNeed, lines: BuiltLine[]): AppError {
  if (need.kind === 'sale.controlled') {
    return new AppError(
      'NEEDS_APPROVAL',
      `Controlled drugs need a PIN from ${approverPhrase(rolesThatCan('sale.controlled'))}`,
      {},
      { permission: 'sale.controlled', kind: need.kind, lineKey: '' },
    );
  }
  const name = lines.find((l) => l.key === need.lineKey)?.product.title;
  const pct = (need.needBp / 100).toFixed(need.needBp % 100 === 0 ? 0 : 2);
  return new AppError(
    'NEEDS_APPROVAL',
    `A ${pct}% discount${name ? ` on ${name}` : ''} needs a PIN from a pharmacist or the owner`,
    {},
    { kind: need.kind, lineKey: need.lineKey, needBp: need.needBp },
  );
}

/**
 * Records the sale saved in the draft, in one transaction: the sale, its lines, the batches
 * each line took stock from (with the stock movements), the payments and any prescription.
 * The sale gets the draft's id, so completing twice returns the same sale.
 */
export async function completeSale(
  ctx: AppContext,
  input: CompleteSaleInput,
): Promise<CompletedSale> {
  const data = completeSchema.parse(input);
  const deviceSettings = await getDeviceSettingsTx(ctx.db);
  return ctx.db.transaction().execute(async (trx) => {
    const done = await completedView(trx, data.draftId);
    if (done) return done;
    const cart = await activeDraftCart(trx, ctx, data.draftId);

    const { actor } = await authorizeTx(trx, ctx, 'sale.sell');
    const clock = await assertClockTx(trx, ctx);
    const shift = await requireOpenShiftTx(trx, ctx);
    const businessDate = today(ctx);
    if (cart.lines.length === 0) throw new AppError('INVALID_STATE', 'Add something to sell first');

    const build = await buildFor(trx, ctx, cart);
    if (build.notAvailable) throw new AppError('NOT_AVAILABLE', build.notAvailable);
    if (Object.keys(build.fields).length > 0) {
      throw new AppError('VALIDATION', Object.values(build.fields)[0]!, build.fields);
    }
    if (build.confirm.length > 0) {
      throw new AppError(
        'NEEDS_CONFIRMATION',
        'Check that the packs in hand are in date: expired stock of this item is on record',
        {},
        { confirm: 'in_date', lines: build.confirm },
      );
    }
    const priced = build.priced!;
    if (priced.total !== data.expectedTotal) {
      throw new AppError(
        'TOTAL_CHANGED',
        `The total is now ${formatMoney(priced.total)} — check the bill`,
        {},
        { total: priced.total, lines: build.lines.map((l) => ({ key: l.key, price: l.price })) },
      );
    }
    const discountNeed = build.needs.find((n) => n.kind === 'sale.discount');
    if (discountNeed) throw approvalError(discountNeed, build.lines);
    if (Object.keys(build.payFields).length > 0) {
      throw new AppError('VALIDATION', Object.values(build.payFields)[0]!, build.payFields);
    }
    const controlledNeed = build.needs.find((n) => n.kind === 'sale.controlled');
    if (controlledNeed) throw approvalError(controlledNeed, build.lines);

    const settled = settleTenders(priced.total, data.tenders as Tender[]);
    if (!settled.ok) {
      if (settled.problem === 'khata_unavailable') {
        throw new AppError('NOT_AVAILABLE', 'Khata comes with customer accounts');
      }
      const message =
        settled.problem === 'short'
          ? `${formatMoney(settled.short!)} still to pay`
          : TENDER_PROBLEMS[settled.problem];
      const field =
        settled.index === undefined
          ? 'tenders'
          : `tenders.${settled.index}.${settled.problem === 'wallet_reference' ? 'reference' : 'amount'}`;
      throw new AppError('VALIDATION', message, { [field]: message });
    }

    // ---- Write ----
    const now = timestamp(ctx);
    const { branchId, deviceId, userId } = ctx.session;
    const device = await trx
      .selectFrom('device')
      .select('code')
      .where('id', '=', deviceId)
      .executeTakeFirstOrThrow();
    const seq = await nextDocSeqTx(trx, ctx, 'sale');
    const saleId = data.draftId;
    const invoiceNo = formatDocNo(device.code, seq);

    // Batches that exist only once the sale does: placeholders and packs typed by hand.
    const placeholderFor = new Map<string, string>();
    const packBatchFor = new Map<string, string>();
    const packBatchCreated: string[] = [];
    for (const line of build.lines) {
      for (const part of line.parts) {
        if (part.batchId) continue;
        if (part.placeholder) {
          let id = placeholderFor.get(line.product.id);
          if (!id) {
            const existing = await trx
              .selectFrom('batch')
              .select('id')
              .where('product_id', '=', line.product.id)
              .where('is_placeholder', '=', 1)
              .executeTakeFirst();
            id = existing?.id ?? ctx.newId();
            if (!existing) {
              await insertRow(trx, now, 'batch', {
                id,
                product_id: line.product.id,
                batch_no: '',
                expiry_date: null,
                pack_qty: line.product.price.perQty,
                cost_price: null,
                mrp: null,
                source: 'adjustment',
                is_placeholder: 1,
                created_at: now,
                updated_at: now,
              });
            }
            placeholderFor.set(line.product.id, id);
          }
          part.batchId = id;
        } else if (part.newPackBatch) {
          // Two lines of the same pack share one new batch.
          const key = [
            line.product.id,
            part.newPackBatch.batchNo.toLowerCase(),
            part.newPackBatch.expiryDate,
          ].join('|');
          const made = packBatchFor.get(key);
          if (made) {
            part.batchId = made;
            continue;
          }
          const id = ctx.newId();
          packBatchFor.set(key, id);
          await insertRow(trx, now, 'batch', {
            id,
            product_id: line.product.id,
            batch_no: part.newPackBatch.batchNo,
            expiry_date: part.newPackBatch.expiryDate,
            pack_qty: line.product.price.perQty,
            cost_price: null,
            mrp: part.newPackBatch.mrp,
            source: 'adjustment',
            is_placeholder: 0,
            created_at: now,
            updated_at: now,
          });
          part.batchId = id;
          packBatchCreated.push(id);
        }
      }
    }

    await insertRow(trx, now, 'sale', {
      id: saleId,
      branch_id: branchId,
      device_id: deviceId,
      shift_id: shift.id,
      invoice_seq: seq,
      invoice_no: invoiceNo,
      business_date: businessDate,
      user_id: userId,
      line_count: build.lines.length,
      gross_total: priced.grossTotal,
      line_discount_total: priced.lineDiscountTotal,
      bill_discount_bp: priced.billDiscountBp,
      bill_discount: priced.billDiscount,
      subtotal: priced.subtotal,
      rounding: priced.rounding,
      total: priced.total,
      tax_total: priced.taxTotal,
      change_given: settled.change,
      cost_total: build.costTotal,
      rx_check: build.rxCheck,
      approved_by: build.billDiscountApprovedBy,
      created_at: now,
    });

    for (const line of build.lines) {
      const p = line.priced!;
      const lineId = ctx.newId();
      const controlled = line.product.schedule !== null;
      await insertRow(trx, now, 'sale_line', {
        id: lineId,
        sale_id: saleId,
        line_no: line.index + 1,
        product_id: line.product.id,
        unit_id: line.line.unitId,
        description: line.product.title,
        qty: line.line.qty,
        qty_text: displayQty(line.line),
        price_amount: line.price.amount,
        price_qty: line.price.perQty,
        price_source: line.priceSource,
        price_reason: null,
        catalog_amount: line.product.price.amount,
        catalog_qty: line.product.price.perQty,
        gross: p.gross,
        discount_source: p.discountSource,
        line_discount_bp: p.lineDiscountBp,
        line_discount: p.lineDiscount,
        bill_discount_share: p.billShare,
        net: p.net,
        tax_class_id: line.product.taxClassId,
        tax_rate_bp: line.product.taxRateBp,
        tax: p.tax,
        cost: line.cost,
        above_mrp: line.aboveMrp ? 1 : 0,
        rx_required: line.product.rxRequired || controlled ? 1 : 0,
        controlled_schedule: line.product.schedule,
        approved_by:
          line.discountApprovedBy ??
          (controlled && build.dispensedBy !== actor.id ? build.dispensedBy : null),
        created_at: now,
      });
      for (const part of line.parts) {
        const movementId = ctx.newId();
        await insertRow(trx, now, 'stock_movement', {
          id: movementId,
          branch_id: branchId,
          device_id: deviceId,
          product_id: line.product.id,
          batch_id: part.batchId!,
          qty: -part.qty,
          kind: 'sale',
          ref_type: 'sale',
          ref_id: saleId,
          reason: part.placeholder ? 'Sold without recorded stock' : null,
          user_id: userId,
          created_at: now,
        });
        await insertRow(trx, now, 'sale_line_batch', {
          id: ctx.newId(),
          sale_id: saleId,
          sale_line_id: lineId,
          batch_id: part.batchId!,
          movement_id: movementId,
          qty: part.qty,
          pick: part.pick,
          stock_before: part.stockBefore,
          batch_no: part.batchNo,
          expiry_date: part.expiryDate,
          cost: part.cost,
          mrp: part.mrp,
          created_at: now,
        });
      }
    }

    for (const pay of settled.payments) {
      await insertRow(trx, now, 'payment', {
        id: ctx.newId(),
        branch_id: branchId,
        device_id: deviceId,
        shift_id: shift.id,
        sale_id: saleId,
        doc_type: 'sale',
        doc_id: saleId,
        method: pay.method,
        wallet_provider: pay.provider,
        reference: pay.reference,
        amount: pay.amount,
        tendered: pay.tendered,
        change_given: pay.change,
        user_id: userId,
        created_at: now,
      });
    }

    let prescriptionId: string | null = null;
    if (build.dispensedBy && build.cart.prescription) {
      const rx = build.cart.prescription;
      prescriptionId = ctx.newId();
      await insertRow(trx, now, 'sale_prescription', {
        id: prescriptionId,
        sale_id: saleId,
        patient_name: rx.patientName.trim(),
        patient_phone: rx.patientPhone?.trim() || null,
        prescriber_name: rx.prescriberName.trim(),
        prescriber_reg_no: rx.prescriberRegNo?.trim() || null,
        rx_date: rx.rxDate || null,
        rx_ref: rx.rxRef?.trim() || null,
        dispensed_by: build.dispensedBy,
        created_at: now,
      });
    }

    await auditSale(trx, ctx, saleId, build, {
      prescriptionId,
      packBatchCreated,
      invoiceNo,
    });
    await noteClockSuspectTx(trx, ctx, shift.id, clock);
    if (deviceSettings.printer.mode !== 'off' && deviceSettings.printer.autoPrint) {
      await setMeta(
        trx,
        META.lastReceipt,
        JSON.stringify({ docType: 'sale', docId: saleId, status: 'pending' }),
      );
    }
    await trx.deleteFrom('sale_draft').where('id', '=', data.draftId).execute();
    await bumpClockTx(trx, ctx);

    const cashReceived = settled.cashApplied;
    return {
      saleId,
      invoiceNo,
      total: priced.total,
      change: settled.change,
      cashReceived,
      alreadyCompleted: false,
      openDrawer: cashReceived > 0,
    };
  });
}

async function auditSale(
  trx: Tx,
  ctx: AppContext,
  saleId: string,
  build: SaleBuild,
  extra: { prescriptionId: string | null; packBatchCreated: string[]; invoiceNo: string },
) {
  const entry = (action: string, after: unknown, approvedBy: string | null = null) =>
    audit(trx, ctx, { action, entityType: 'sale', entityId: saleId, after, approvedBy });
  const priced = build.priced!;

  const discounted = build.lines.filter((l) => l.priced!.discountSource === 'manual');
  if (discounted.length > 0 || priced.billDiscount > 0) {
    const approvers = [
      build.billDiscountApprovedBy,
      ...build.lines.map((l) => l.discountApprovedBy),
    ].filter(Boolean);
    await entry(
      'sale.discount',
      {
        invoiceNo: extra.invoiceNo,
        lines: discounted.map((l) => ({
          product: l.product.title,
          discount: l.line.discount,
          amount: l.priced!.lineDiscount,
        })),
        bill: build.cart.billDiscount,
        billAmount: priced.billDiscount,
      },
      approvers[0] ?? null,
    );
  }
  const aboveMrp = build.lines.filter((l) => l.aboveMrp);
  if (aboveMrp.length > 0) {
    await entry('sale.above_mrp', {
      lines: aboveMrp.map((l) => ({
        product: l.product.title,
        batches: l.parts.map((p) => p.batchNo),
        mrp: l.aboveMrp!.mrpPrice,
        net: l.priced!.net,
        over: l.aboveMrp!.over,
      })),
    });
  }
  const pastZero = build.warnings.filter((w) => w.kind === 'past_zero');
  if (pastZero.length > 0) {
    await entry('sale.past_zero', {
      lines: pastZero.map((w) => {
        const line = build.lines.find((l) => l.key === w.lineKey)!;
        return {
          product: line.product.title,
          qty: w.qty,
          recorded: w.recorded,
          picks: line.parts.map((p) => ({ batchNo: p.batchNo, qty: p.qty, pick: p.pick })),
        };
      }),
    });
  }
  const expired = build.warnings.filter((w) => w.kind === 'expired_on_record');
  if (expired.length > 0) {
    await entry('sale.expired_on_record', {
      lines: expired.map((w) => ({
        product: build.lines.find((l) => l.key === w.lineKey)!.product.title,
        inDate: w.inDate,
        shortfall: w.shortfall,
        expiredQty: w.expiredQty,
        batches: w.batches,
      })),
    });
  }
  if (build.rxCheck === 'not_seen') {
    await entry('sale.rx_not_seen', {
      lines: build.lines.filter((l) => l.product.rxRequired).map((l) => l.product.title),
    });
  }
  const controlled = build.lines.filter((l) => l.product.schedule !== null);
  if (controlled.length > 0) {
    await entry(
      'sale.controlled',
      {
        lines: controlled.map((l) => ({
          product: l.product.title,
          schedule: l.product.schedule,
          qty: l.line.qty,
          batches: l.parts.map((p) => p.batchNo),
        })),
        prescriptionId: extra.prescriptionId,
        dispensedBy: build.dispensedBy,
        packBatchCreated: extra.packBatchCreated,
      },
      build.dispensedBy !== ctx.session.userId ? build.dispensedBy : null,
    );
  }
  if (build.cart.removed.length > 0) {
    await entry('sale.lines_removed', { removed: build.cart.removed });
  }
}

/** The last receipt that was meant to print, and whether it did. */
export async function getLastReceipt(
  ctx: AppContext,
): Promise<{ docType: string; docId: string; status: string } | null> {
  const raw = await getMeta(ctx.db, META.lastReceipt);
  try {
    return raw ? (JSON.parse(raw) as { docType: string; docId: string; status: string }) : null;
  } catch {
    return null;
  }
}
