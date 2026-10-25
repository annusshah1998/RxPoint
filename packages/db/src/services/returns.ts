import {
  AppError,
  USER_ROLES,
  allocateProRata,
  approverPhrase,
  can,
  daysBetween,
  formatDocNo,
  formatMoney,
  formatQty,
  isApprovable,
  refundShare,
  refundTotal,
  splitReturnQty,
  type IsoDate,
  type Money,
  type PaymentMethod,
  type Permission,
  type UnitDef,
  type WalletProvider,
} from '@app/core';
import { z } from 'zod';
import { timestamp, today, type AppContext } from '../context';
import type { Db } from '../executor';
import { META, setMeta } from '../meta';
import type { BatchPick, ReturnReason, SaleRow } from '../schema';
import { optionalText, parseInput } from '../validation';
import { audit, insertRow, type Tx } from '../writes';
import {
  actorTx,
  assertClockTx,
  authorizeTx,
  bumpClockTx,
  expectedCashTx,
  expiryTodayTx,
  nextDocSeqTx,
  noteClockSuspectTx,
  requireOpenShiftTx,
  verifyApprover,
  type Actor,
  type Approval,
  type ApprovalInput,
} from './guards';
import { getDeviceSettingsTx, getStoreSettingsTx, type StoreSettings } from './settings';

/*
 * Returns (docs/m2-design.md §4.7). A return never changes the sale: it adds a
 * `sale_return` with one line per batch piece, stock movements for what goes back on the
 * shelf, and negative payments for the refund. Refunds use cumulative shares, so every
 * return of a sale adds up exactly to what the customer paid.
 */

export const RETURN_REASONS = [
  'wrong_item',
  'doctor_changed',
  'side_effect',
  'damaged',
  'expired',
  'other',
] as const satisfies readonly ReturnReason[];

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface LoadedAlloc {
  id: string;
  batchId: string;
  batchNo: string;
  expiryDate: IsoDate | null;
  pick: BatchPick;
  qty: number;
  cost: Money | null;
  returned: number;
  returnedCost: Money;
}

interface LoadedLine {
  id: string;
  lineNo: number;
  productId: string;
  unitId: string;
  description: string;
  qtyText: string;
  qty: number;
  net: Money;
  tax: Money;
  taxRateBp: number;
  schedule: string | null;
  returnedQty: number;
  returnedRefund: Money;
  returnedTax: Money;
  units: (UnitDef & { id: string })[];
  allocs: LoadedAlloc[];
}

/** A way the sale was paid, with what has gone back that way since. */
export interface RefundChannel {
  method: Exclude<PaymentMethod, 'khata'>;
  provider: WalletProvider | null;
  /** The reference of the original payment (card slip or wallet transaction). */
  reference: string | null;
  paid: Money;
  refunded: Money;
  /** At most this much can still go back this way (cash is limited by the drawer instead). */
  left: Money;
}

interface LoadedSale {
  sale: SaleRow;
  voided: boolean;
  lines: LoadedLine[];
  refundNetBefore: Money;
  refundedBefore: Money;
  channels: RefundChannel[];
  returns: { id: string; returnNo: string; at: string; refundTotal: Money; by: string }[];
}

const channelKey = (method: string, provider: string | null) => `${method}:${provider ?? ''}`;
const METHOD_ORDER: Record<RefundChannel['method'], number> = { cash: 0, card: 1, wallet: 2 };

async function loadSaleTx(db: Db | Tx, saleId: string): Promise<LoadedSale> {
  const sale = await db.selectFrom('sale').selectAll().where('id', '=', saleId).executeTakeFirst();
  if (!sale) throw new AppError('NOT_FOUND', 'Sale not found');
  const voided = await db
    .selectFrom('sale_void')
    .select('id')
    .where('sale_id', '=', saleId)
    .executeTakeFirst();
  const lines = await db
    .selectFrom('sale_line')
    .selectAll()
    .where('sale_id', '=', saleId)
    .orderBy('line_no')
    .execute();
  const allocs = await db
    .selectFrom('sale_line_batch')
    .selectAll()
    .where('sale_id', '=', saleId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const returns = await db
    .selectFrom('sale_return as r')
    .innerJoin('app_user as u', 'u.id', 'r.user_id')
    .select([
      'r.id',
      'r.return_no',
      'r.created_at',
      'r.refund_net',
      'r.refund_total',
      'u.name as by',
    ])
    .where('r.sale_id', '=', saleId)
    .orderBy('r.return_seq')
    .execute();
  const returnLines =
    returns.length === 0
      ? []
      : await db
          .selectFrom('sale_return_line')
          .select(['sale_line_id', 'sale_line_batch_id', 'qty', 'refund', 'tax', 'cost'])
          .where(
            'return_id',
            'in',
            returns.map((r) => r.id),
          )
          .execute();
  const productIds = [...new Set(lines.map((l) => l.product_id))];
  const units =
    productIds.length === 0
      ? []
      : await db
          .selectFrom('product_unit')
          .select(['id', 'product_id', 'name', 'qty', 'is_active'])
          .where('product_id', 'in', productIds)
          .execute();
  const payments = await db
    .selectFrom('payment')
    .select(['doc_type', 'method', 'wallet_provider', 'reference', 'amount'])
    .where('sale_id', '=', saleId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();

  const channels = new Map<string, RefundChannel>();
  for (const p of payments) {
    if (p.method === 'khata') continue;
    const key = channelKey(p.method, p.wallet_provider);
    if (p.doc_type === 'sale') {
      const c = channels.get(key);
      if (c) c.paid += p.amount;
      else {
        channels.set(key, {
          method: p.method,
          provider: p.wallet_provider,
          reference: p.reference,
          paid: p.amount,
          refunded: 0,
          left: 0,
        });
      }
    }
  }
  for (const p of payments) {
    if (p.doc_type !== 'return' || p.method === 'khata') continue;
    const c = channels.get(channelKey(p.method, p.wallet_provider));
    if (c) c.refunded -= p.amount;
  }
  for (const c of channels.values()) c.left = Math.max(0, c.paid - c.refunded);

  return {
    sale,
    voided: !!voided,
    lines: lines.map((l) => {
      const mine = returnLines.filter((r) => r.sale_line_id === l.id);
      const active = units.filter((u) => u.product_id === l.product_id && u.is_active === 1);
      const productUnits = (
        active.some((u) => u.qty === 1)
          ? active
          : units.filter((u) => u.product_id === l.product_id)
      ).map((u) => ({ id: u.id, name: u.name, qty: u.qty }));
      return {
        id: l.id,
        lineNo: l.line_no,
        productId: l.product_id,
        unitId: l.unit_id,
        description: l.description,
        qtyText: l.qty_text,
        qty: l.qty,
        net: l.net,
        tax: l.tax,
        taxRateBp: l.tax_rate_bp,
        schedule: l.controlled_schedule,
        returnedQty: sum(mine.map((r) => r.qty)),
        returnedRefund: sum(mine.map((r) => r.refund)),
        returnedTax: sum(mine.map((r) => r.tax)),
        units: productUnits,
        allocs: allocs
          .filter((a) => a.sale_line_id === l.id)
          .map((a) => {
            const back = returnLines.filter((r) => r.sale_line_batch_id === a.id);
            return {
              id: a.id,
              batchId: a.batch_id,
              batchNo: a.batch_no,
              expiryDate: a.expiry_date,
              pick: a.pick,
              qty: a.qty,
              cost: a.cost,
              returned: sum(back.map((r) => r.qty)),
              returnedCost: sum(back.map((r) => r.cost ?? 0)),
            };
          })
          .sort(allocationOrder),
      };
    }),
    refundNetBefore: sum(returns.map((r) => r.refund_net)),
    refundedBefore: sum(returns.map((r) => r.refund_total)),
    // Cash, card, then wallets: payments written together have no reliable order.
    channels: [...channels.values()].sort(
      (a, b) =>
        METHOD_ORDER[a.method] - METHOD_ORDER[b.method] ||
        (a.provider ?? '').localeCompare(b.provider ?? ''),
    ),
    returns: returns.map((r) => ({
      id: r.id,
      returnNo: r.return_no,
      at: r.created_at,
      refundTotal: r.refund_total,
      by: r.by,
    })),
  };
}

function sum(values: number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

/**
 * The order a line's batches were allocated in, as FEFO takes them: earliest expiry first,
 * undated batches after, unrecorded stock last. (Rows written in one transaction share a
 * timestamp and their ids are random within it, so neither keeps the order.)
 */
function allocationOrder(a: LoadedAlloc, b: LoadedAlloc): number {
  const unrecorded = Number(a.pick === 'unrecorded') - Number(b.pick === 'unrecorded');
  if (unrecorded !== 0) return unrecorded;
  if (a.expiryDate !== b.expiryDate) {
    if (a.expiryDate === null) return 1;
    if (b.expiryDate === null) return -1;
    return a.expiryDate < b.expiryDate ? -1 : 1;
  }
  return a.batchNo === b.batchNo ? (a.id < b.id ? -1 : 1) : a.batchNo < b.batchNo ? -1 : 1;
}

function isExpired(expiry: IsoDate | null, expiryToday: IsoDate): boolean {
  return expiry !== null && daysBetween(expiryToday, expiry) < 0;
}

function qtyText(qty: number, units: readonly UnitDef[]): string {
  return units.length > 0 ? formatQty(qty, units) : String(qty);
}

// ---------------------------------------------------------------------------
// What can be returned
// ---------------------------------------------------------------------------

export interface ReturnableLine {
  saleLineId: string;
  lineNo: number;
  productId: string;
  description: string;
  /** Base units. */
  sold: number;
  returned: number;
  returnable: number;
  soldText: string;
  returnedText: string;
  returnableText: string;
  /** Pack sizes, for typing a quantity ("1s 2t"); a plain number means `defaultUnitId`. */
  units: { id: string; name: string; qty: number }[];
  /** The unit the line was sold in. */
  defaultUnitId: string;
  controlled: boolean;
  /** False when every batch still returnable has expired: nothing can go back on the shelf. */
  canRestock: boolean;
}

export interface ReturnableSale {
  saleId: string;
  invoiceNo: string;
  businessDate: IsoDate;
  daysSince: number;
  returnDays: number;
  /** Past the store's return window: needs `sale.return_late`. */
  late: boolean;
  total: Money;
  refundedBefore: Money;
  fullyReturned: boolean;
  lines: ReturnableLine[];
  channels: RefundChannel[];
  returns: { id: string; returnNo: string; at: string; refundTotal: Money; by: string }[];
}

/** A sale as the Return screen needs it: what is left to return, per line and per payment. */
export async function getReturnableSale(ctx: AppContext, saleId: string): Promise<ReturnableSale> {
  const loaded = await loadSaleTx(ctx.db, saleId);
  if (loaded.voided)
    throw new AppError('INVALID_STATE', 'This sale was voided — nothing to return');
  const settings = await getStoreSettingsTx(ctx.db, ctx.session.branchId);
  const expiryToday = await expiryTodayTx(ctx.db, ctx);
  const daysSince = Math.max(0, daysBetween(loaded.sale.business_date, today(ctx)));
  const lines = loaded.lines.map((l): ReturnableLine => {
    const returnable = l.qty - l.returnedQty;
    return {
      saleLineId: l.id,
      lineNo: l.lineNo,
      productId: l.productId,
      description: l.description,
      sold: l.qty,
      returned: l.returnedQty,
      returnable,
      soldText: l.qtyText,
      returnedText: qtyText(l.returnedQty, l.units),
      returnableText: qtyText(returnable, l.units),
      units: l.units,
      defaultUnitId: l.unitId,
      controlled: l.schedule !== null,
      canRestock: l.allocs.some((a) => a.qty > a.returned && !isExpired(a.expiryDate, expiryToday)),
    };
  });
  return {
    saleId: loaded.sale.id,
    invoiceNo: loaded.sale.invoice_no,
    businessDate: loaded.sale.business_date,
    daysSince,
    returnDays: settings.returnDays,
    late: daysSince > settings.returnDays,
    total: loaded.sale.total,
    refundedBefore: loaded.refundedBefore,
    fullyReturned: lines.every((l) => l.returnable === 0),
    lines,
    channels: loaded.channels,
    returns: loaded.returns,
  };
}

// ---------------------------------------------------------------------------
// Working out a return
// ---------------------------------------------------------------------------

const lineRequestSchema = z.object({
  saleLineId: z.string().min(1),
  qty: z.number().int('Enter a whole number').min(0, 'Enter how many'),
  restock: z.boolean().default(true),
});

const refundSchema = z.object({
  method: z.enum(['cash', 'card', 'wallet', 'khata']),
  provider: z.enum(['jazzcash', 'easypaisa', 'raast', 'other']).nullish(),
  amount: z.number().int().min(0, 'Enter an amount'),
  reference: z.string().trim().max(40).nullish(),
});

export type ReturnLineRequest = z.input<typeof lineRequestSchema>;
export type RefundInput = z.input<typeof refundSchema>;

export interface ReturnPiece {
  allocationId: string;
  batchId: string;
  batchNo: string;
  expiryDate: IsoDate | null;
  qty: number;
  refund: Money;
  tax: Money;
  cost: Money | null;
  /** Goes back on the shelf (never for an expired batch). */
  restock: boolean;
  expired: boolean;
}

export interface PlannedReturnLine {
  saleLineId: string;
  description: string;
  qty: number;
  qtyText: string;
  refund: Money;
  tax: Money;
  controlled: boolean;
  pieces: ReturnPiece[];
}

export interface ReturnPlan {
  lines: PlannedReturnLine[];
  refundNet: Money;
  taxTotal: Money;
  costTotal: Money | null;
  rounding: Money;
  refundTotal: Money;
  /** Everything sold is now back: the refund is exactly what is left of the sale total. */
  isFinal: boolean;
  /** Problems, keyed by form path (`lines.0.qty`). Empty when the return can go ahead. */
  fields: Record<string, string>;
  /** How to pay the refund back, as the sale was paid. */
  suggestedRefunds: {
    method: 'cash' | 'card' | 'wallet';
    provider: WalletProvider | null;
    amount: Money;
    reference: string | null;
  }[];
  /** Permissions the acting user lacks for this return (someone else's PIN covers them). */
  needs: Permission[];
  late: boolean;
  daysSince: number;
}

interface Computed {
  lines: PlannedReturnLine[];
  refundNet: Money;
  taxTotal: Money;
  costTotal: Money | null;
  rounding: Money;
  refundTotal: Money;
  isFinal: boolean;
  fields: Record<string, string>;
}

/** Spreads `taxes` so no piece's tax is more than its refund (the totals already fit). */
function fitTax(refunds: Money[], taxes: Money[]): Money[] {
  let excess = 0;
  const out = taxes.map((t, i) => {
    const fitted = Math.min(t, refunds[i]!);
    excess += t - fitted;
    return fitted;
  });
  for (let i = 0; i < out.length && excess > 0; i++) {
    const add = Math.min(refunds[i]! - out[i]!, excess);
    out[i]! += add;
    excess -= add;
  }
  return out;
}

function computeReturn(
  loaded: LoadedSale,
  requests: z.output<typeof lineRequestSchema>[],
  expiryToday: IsoDate,
  settings: StoreSettings,
): Computed {
  const fields: Record<string, string> = {};
  const lines: PlannedReturnLine[] = [];
  const seen = new Set<string>();
  const now = new Map<string, number>();

  requests.forEach((req, i) => {
    const line = loaded.lines.find((l) => l.id === req.saleLineId);
    if (!line) {
      fields[`lines.${i}.qty`] = 'This item is not on the sale';
      return;
    }
    if (seen.has(line.id)) {
      fields[`lines.${i}.qty`] = 'This item is listed twice';
      return;
    }
    seen.add(line.id);
    if (req.qty === 0) return;
    const left = line.qty - line.returnedQty;
    if (req.qty > left) {
      fields[`lines.${i}.qty`] =
        left === 0
          ? 'All of this was returned already'
          : `Only ${qtyText(left, line.units)} left to return`;
      return;
    }
    now.set(line.id, req.qty);

    const refund = refundShare(line.net, line.qty, line.returnedQty, line.returnedRefund, req.qty);
    const tax = Math.min(
      refundShare(line.tax, line.qty, line.returnedQty, line.returnedTax, req.qty),
      refund,
    );
    const split = splitReturnQty(line.allocs, req.qty);
    const qtys = split.map((p) => p.qty);
    const refunds = allocateProRata(refund, qtys);
    const taxes = fitTax(refunds, allocateProRata(tax, qtys));
    const pieces = split.map((p, j): ReturnPiece => {
      const a = line.allocs.find((x) => x.id === p.id)!;
      const expired = isExpired(a.expiryDate, expiryToday);
      return {
        allocationId: a.id,
        batchId: a.batchId,
        batchNo: a.batchNo,
        expiryDate: a.expiryDate,
        qty: p.qty,
        refund: refunds[j]!,
        tax: taxes[j]!,
        cost:
          a.cost === null ? null : refundShare(a.cost, a.qty, a.returned, a.returnedCost, p.qty),
        restock: req.restock && !expired,
        expired,
      };
    });
    lines.push({
      saleLineId: line.id,
      description: line.description,
      qty: req.qty,
      qtyText: qtyText(req.qty, line.units),
      refund,
      tax,
      controlled: line.schedule !== null,
      pieces,
    });
  });

  if (lines.length === 0 && Object.keys(fields).length === 0) {
    fields['lines'] = 'Enter how many of an item are coming back';
  }
  const refundNet = sum(lines.map((l) => l.refund));
  const taxTotal = sum(lines.map((l) => l.tax));
  const costs = lines.flatMap((l) => l.pieces.map((p) => p.cost));
  const isFinal =
    lines.length > 0 && loaded.lines.every((l) => l.returnedQty + (now.get(l.id) ?? 0) === l.qty);
  const { total, rounding } =
    lines.length === 0
      ? { total: 0, rounding: 0 }
      : refundTotal({
          refundNetBefore: loaded.refundNetBefore,
          refundNetNow: refundNet,
          isFinal,
          saleTotal: loaded.sale.total,
          refundedBefore: loaded.refundedBefore,
          rule: settings.rounding,
        });
  return {
    lines,
    refundNet,
    taxTotal,
    costTotal: costs.some((c) => c === null) ? null : sum(costs as number[]),
    rounding,
    refundTotal: total,
    isFinal,
    fields,
  };
}

/** Cash back first (up to the cash paid), then card and wallets, then any rest in cash. */
function suggestRefunds(total: Money, channels: RefundChannel[]): ReturnPlan['suggestedRefunds'] {
  const out = new Map<string, ReturnPlan['suggestedRefunds'][number]>();
  let left = total;
  const give = (c: Pick<RefundChannel, 'method' | 'provider' | 'reference'>, amount: number) => {
    if (amount <= 0) return;
    const key = channelKey(c.method, c.provider);
    const row = out.get(key);
    if (row) row.amount += amount;
    else out.set(key, { method: c.method, provider: c.provider, reference: c.reference, amount });
    left -= amount;
  };
  const cash = channels.find((c) => c.method === 'cash');
  if (cash) give(cash, Math.min(left, cash.left));
  for (const c of channels) if (c.method !== 'cash') give(c, Math.min(left, c.left));
  give({ method: 'cash', provider: null, reference: null }, left);
  return [...out.values()];
}

/** Everything a return needs: `sale.return`, plus late and controlled-drug permissions. */
function returnNeeds(computed: Computed, settings: StoreSettings, daysSince: number): Permission[] {
  const needs: Permission[] = ['sale.return'];
  if (daysSince > settings.returnDays) needs.push('sale.return_late');
  if (computed.lines.some((l) => l.controlled)) needs.push('sale.controlled');
  return needs;
}

function needsApprovalError(lacking: Permission[], daysSince: number, settings: StoreSettings) {
  const roles = USER_ROLES.filter((r) => lacking.every((p) => can(r, p)));
  const who = approverPhrase(roles);
  const message = lacking.includes('sale.return_late')
    ? `This sale is ${daysSince} days old. Returns after ${settings.returnDays} days need a PIN from ${who}`
    : lacking.includes('sale.controlled')
      ? `Taking back a controlled drug needs a PIN from ${who}`
      : `Returns need a PIN from ${who}`;
  return new AppError(
    'NEEDS_APPROVAL',
    message,
    {},
    { permission: lacking[0], permissions: lacking },
  );
}

const planSchema = z.object({
  saleId: z.string().min(1),
  lines: z.array(lineRequestSchema).max(200),
});

/** Prices a return without writing anything: refund per line, rounding, and how to pay it back. */
export async function planReturn(
  ctx: AppContext,
  input: z.input<typeof planSchema>,
): Promise<ReturnPlan> {
  const data = parseInput(planSchema, input);
  const loaded = await loadSaleTx(ctx.db, data.saleId);
  if (loaded.voided)
    throw new AppError('INVALID_STATE', 'This sale was voided — nothing to return');
  const settings = await getStoreSettingsTx(ctx.db, ctx.session.branchId);
  const computed = computeReturn(loaded, data.lines, await expiryTodayTx(ctx.db, ctx), settings);
  const daysSince = Math.max(0, daysBetween(loaded.sale.business_date, today(ctx)));
  const actor = await actorTx(ctx.db, ctx);
  return {
    ...computed,
    suggestedRefunds: suggestRefunds(computed.refundTotal, loaded.channels),
    needs: returnNeeds(computed, settings, daysSince).filter((p) => !can(actor.role, p)),
    late: daysSince > settings.returnDays,
    daysSince,
  };
}

// ---------------------------------------------------------------------------
// Recording a return
// ---------------------------------------------------------------------------

const createSchema = z.object({
  saleId: z.string().min(1),
  lines: z.array(lineRequestSchema).max(200),
  reason: z.enum(RETURN_REASONS, 'Choose why it is coming back'),
  note: optionalText(200),
  refunds: z.array(refundSchema).max(10),
  /** The refund the screen showed; if it changed meanwhile the return is refused. */
  expectedRefund: z.number().int().min(0),
  approval: z.object({ userId: z.string(), pin: z.string() }).nullish(),
});

export type CreateReturnInput = z.input<typeof createSchema>;

export interface ReturnResult {
  returnId: string;
  returnNo: string;
  invoiceNo: string;
  refundTotal: Money;
  /** Cash to hand back from the drawer. */
  cashToGiveBack: Money;
  /** Card and wallet refunds to make on the terminal or app. */
  nonCash: {
    method: PaymentMethod;
    provider: WalletProvider | null;
    reference: string | null;
    amount: Money;
  }[];
  openDrawer: boolean;
}

/** Checks a verified approver covers every permission the return needs. */
async function returnApproval(
  ctx: AppContext,
  input: ApprovalInput | null | undefined,
  lacking: Permission[],
): Promise<Approval | null> {
  if (!input || lacking.length === 0) return null;
  const first = lacking[0]!;
  if (!isApprovable(first)) throw new AppError('FORBIDDEN', 'Only the owner can do this');
  const approval = await verifyApprover(ctx, input, first);
  const missing = lacking.find((p) => !can(approval.role, p));
  if (missing) {
    throw new AppError('FORBIDDEN', `${approval.name} can’t approve this`, {
      userId: `Needs ${approverPhrase(USER_ROLES.filter((r) => lacking.every((p) => can(r, p))))}`,
    });
  }
  return approval;
}

/** Validated refund rows: zero amounts dropped, each within what can go back that way. */
async function checkRefunds(
  trx: Tx,
  ctx: AppContext,
  actor: Actor,
  shiftId: string,
  refunds: z.output<typeof refundSchema>[],
  total: Money,
  channels: RefundChannel[],
): Promise<
  {
    method: 'cash' | 'card' | 'wallet';
    provider: WalletProvider | null;
    reference: string | null;
    amount: Money;
  }[]
> {
  const fields: Record<string, string> = {};
  const rows: Awaited<ReturnType<typeof checkRefunds>> = [];
  const byChannel = new Map<string, number>();
  refunds.forEach((r, i) => {
    if (r.amount === 0) return;
    if (r.method === 'khata') {
      throw new AppError('NOT_AVAILABLE', 'Khata comes with customer accounts', {
        [`refunds.${i}.method`]: 'Not available yet',
      });
    }
    const provider = r.method === 'wallet' ? (r.provider ?? null) : null;
    if (r.method === 'wallet' && !provider) {
      fields[`refunds.${i}.provider`] = 'Choose the wallet';
      return;
    }
    if (r.method !== 'cash') {
      const channel = channels.find((c) => c.method === r.method && c.provider === provider);
      const key = channelKey(r.method, provider);
      const already = byChannel.get(key) ?? 0;
      if (!channel) {
        fields[`refunds.${i}.amount`] =
          r.method === 'card' ? 'This sale wasn’t paid by card' : 'This sale wasn’t paid this way';
        return;
      }
      if (already + r.amount > channel.left) {
        fields[`refunds.${i}.amount`] = `At most ${formatMoney(channel.left)} can go back this way`;
        return;
      }
      byChannel.set(key, already + r.amount);
      rows.push({
        method: r.method,
        provider,
        reference: r.reference || channel.reference,
        amount: r.amount,
      });
      return;
    }
    rows.push({ method: 'cash', provider: null, reference: null, amount: r.amount });
  });
  if (Object.keys(fields).length > 0) {
    throw new AppError('VALIDATION', Object.values(fields)[0]!, fields);
  }
  const given = sum(rows.map((r) => r.amount));
  if (given !== total) {
    const message =
      total === 0
        ? 'Nothing is due back on this return'
        : `The refund adds up to ${formatMoney(given)}, but ${formatMoney(total)} is due back`;
    throw new AppError('VALIDATION', message, { refunds: message });
  }
  const cash = sum(rows.filter((r) => r.method === 'cash').map((r) => r.amount));
  if (cash > 0) {
    const inDrawer = await expectedCashTx(trx, shiftId);
    if (cash > inDrawer) {
      const message = can(actor.role, 'shift.view_expected')
        ? `Only ${formatMoney(Math.max(0, inDrawer))} should be in the drawer`
        : 'Not enough cash in the drawer for this refund';
      throw new AppError('VALIDATION', message, { refunds: message });
    }
  }
  return rows;
}

/**
 * Takes items back from a sale, in one transaction: the return, a line per batch piece
 * (with a stock movement when it goes back on the shelf) and the refund payments. Needs a
 * pharmacist or the owner, the owner after the return window, and a pharmacist for
 * controlled drugs; one approver's PIN must cover everything that is needed.
 */
export async function createReturn(
  ctx: AppContext,
  input: CreateReturnInput,
): Promise<ReturnResult> {
  const data = parseInput(createSchema, input);
  const settings = await getStoreSettingsTx(ctx.db, ctx.session.branchId);
  const deviceSettings = await getDeviceSettingsTx(ctx.db);

  // Work out who must approve before the transaction: PIN checks are slow on purpose.
  let approval: Approval | null = null;
  if (data.approval) {
    const loaded = await loadSaleTx(ctx.db, data.saleId);
    const computed = computeReturn(loaded, data.lines, await expiryTodayTx(ctx.db, ctx), settings);
    const days = Math.max(0, daysBetween(loaded.sale.business_date, today(ctx)));
    const actor = await actorTx(ctx.db, ctx);
    const lacking = returnNeeds(computed, settings, days).filter((p) => !can(actor.role, p));
    approval = await returnApproval(ctx, data.approval, lacking);
  }

  return ctx.db.transaction().execute(async (trx) => {
    const actor = await actorTx(trx, ctx);
    const clock = await assertClockTx(trx, ctx);
    const shift = await requireOpenShiftTx(trx, ctx);
    const loaded = await loadSaleTx(trx, data.saleId);
    if (loaded.voided) {
      throw new AppError('INVALID_STATE', 'This sale was voided — nothing to return');
    }
    const computed = computeReturn(loaded, data.lines, await expiryTodayTx(trx, ctx), settings);
    if (Object.keys(computed.fields).length > 0) {
      throw new AppError('VALIDATION', Object.values(computed.fields)[0]!, computed.fields);
    }
    if (computed.refundTotal !== data.expectedRefund) {
      throw new AppError(
        'TOTAL_CHANGED',
        `The refund is now ${formatMoney(computed.refundTotal)}. Check it and try again.`,
        {},
        { refundTotal: computed.refundTotal },
      );
    }
    const refunds = await checkRefunds(
      trx,
      ctx,
      actor,
      shift.id,
      data.refunds,
      computed.refundTotal,
      loaded.channels,
    );

    const daysSince = Math.max(0, daysBetween(loaded.sale.business_date, today(ctx)));
    const lacking = returnNeeds(computed, settings, daysSince).filter((p) => !can(actor.role, p));
    let approvedBy: string | null = null;
    if (lacking.length > 0) {
      if (!approval || lacking.some((p) => !can(approval.role, p))) {
        throw needsApprovalError(lacking, daysSince, settings);
      }
      for (const p of lacking) await authorizeTx(trx, ctx, p, approval);
      approvedBy = approval.userId;
    }

    // ---- Write ----
    const now = timestamp(ctx);
    const { branchId, deviceId, userId } = ctx.session;
    const device = await trx
      .selectFrom('device')
      .select('code')
      .where('id', '=', deviceId)
      .executeTakeFirstOrThrow();
    const seq = await nextDocSeqTx(trx, ctx, 'return');
    const returnId = ctx.newId();
    const returnNo = formatDocNo(device.code, seq, 'R');
    await insertRow(trx, now, 'sale_return', {
      id: returnId,
      sale_id: loaded.sale.id,
      branch_id: branchId,
      device_id: deviceId,
      shift_id: shift.id,
      return_seq: seq,
      return_no: returnNo,
      business_date: today(ctx),
      user_id: userId,
      approved_by: approvedBy,
      reason: data.reason,
      note: data.note,
      refund_net: computed.refundNet,
      tax_total: computed.taxTotal,
      rounding: computed.rounding,
      refund_total: computed.refundTotal,
      cost_total: computed.costTotal,
      created_at: now,
    });

    for (const line of computed.lines) {
      const productId = loaded.lines.find((l) => l.id === line.saleLineId)!.productId;
      for (const piece of line.pieces) {
        let movementId: string | null = null;
        if (piece.restock) {
          movementId = ctx.newId();
          await insertRow(trx, now, 'stock_movement', {
            id: movementId,
            branch_id: branchId,
            device_id: deviceId,
            product_id: productId,
            batch_id: piece.batchId,
            qty: piece.qty,
            kind: 'sale_return',
            ref_type: 'sale_return',
            ref_id: returnId,
            reason: data.reason,
            user_id: userId,
            created_at: now,
          });
        }
        await insertRow(trx, now, 'sale_return_line', {
          id: ctx.newId(),
          return_id: returnId,
          sale_line_id: line.saleLineId,
          sale_line_batch_id: piece.allocationId,
          batch_id: piece.batchId,
          qty: piece.qty,
          refund: piece.refund,
          tax: piece.tax,
          cost: piece.cost,
          restock: piece.restock ? 1 : 0,
          movement_id: movementId,
          created_at: now,
        });
      }
    }

    for (const r of refunds) {
      await insertRow(trx, now, 'payment', {
        id: ctx.newId(),
        branch_id: branchId,
        device_id: deviceId,
        shift_id: shift.id,
        sale_id: loaded.sale.id,
        doc_type: 'return',
        doc_id: returnId,
        method: r.method,
        wallet_provider: r.provider,
        reference: r.reference,
        amount: -r.amount,
        tendered: null,
        change_given: null,
        user_id: userId,
        created_at: now,
      });
    }

    await audit(trx, ctx, {
      action: 'sale.return',
      entityType: 'sale',
      entityId: loaded.sale.id,
      after: {
        returnId,
        returnNo,
        invoiceNo: loaded.sale.invoice_no,
        refundTotal: computed.refundTotal,
        lines: computed.lines.map((l) => ({
          item: l.description,
          qty: l.qty,
          refund: l.refund,
          restocked: sum(l.pieces.filter((p) => p.restock).map((p) => p.qty)),
        })),
        refunds: refunds.map((r) => ({ method: r.method, provider: r.provider, amount: r.amount })),
      },
      reason: data.note ? `${data.reason}: ${data.note}` : data.reason,
      approvedBy,
    });
    await noteClockSuspectTx(trx, ctx, shift.id, clock);
    if (deviceSettings.printer.mode !== 'off' && deviceSettings.printer.autoPrint) {
      await setMeta(
        trx,
        META.lastReceipt,
        JSON.stringify({ docType: 'return', docId: returnId, status: 'pending' }),
      );
    }
    await bumpClockTx(trx, ctx);

    const cash = sum(refunds.filter((r) => r.method === 'cash').map((r) => r.amount));
    return {
      returnId,
      returnNo,
      invoiceNo: loaded.sale.invoice_no,
      refundTotal: computed.refundTotal,
      cashToGiveBack: cash,
      nonCash: refunds
        .filter((r) => r.method !== 'cash')
        .map((r) => ({
          method: r.method,
          provider: r.provider,
          reference: r.reference,
          amount: r.amount,
        })),
      openDrawer: cash > 0,
    };
  });
}
