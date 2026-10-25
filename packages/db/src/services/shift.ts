import {
  AppError,
  PKR_NOTES,
  can,
  countTotal,
  formatDate,
  formatMoney,
  type CashCount,
  type Money,
  type PaymentMethod,
} from '@app/core';
import { sql } from 'kysely';
import { z } from 'zod';
import { timestamp, today, type AppContext } from '../context';
import type { Db } from '../executor';
import type { CashMovementCategory, ShiftRow } from '../schema';
import { optionalText, parseInput, requiredText } from '../validation';
import { audit, insertRow, updateRow, type Tx } from '../writes';
import {
  actorTx,
  assertClockTx,
  authorizeTx,
  bumpClockTx,
  expectedCashTx,
  getOpenShiftTx,
  noteClockSuspectTx,
  requireOpenShiftTx,
  resolveApproval,
  type ApprovalInput,
} from './guards';
import { getStoreSettingsTx } from './settings';

/** A shift open longer than this is probably one someone forgot to close. */
const STALE_HOURS = 18;

export interface OpenShift {
  id: string;
  shiftNo: number;
  businessDate: string;
  openedAt: string;
  openedBy: string;
  openingFloat: Money;
  /** Open for more than 18 hours: someone probably forgot to close it. */
  stale: boolean;
}

async function userName(db: Db | Tx, id: string | null): Promise<string> {
  if (!id) return '';
  const row = await db
    .selectFrom('app_user')
    .select('name')
    .where('id', '=', id)
    .executeTakeFirst();
  return row?.name ?? '';
}

async function toOpenShift(db: Db | Tx, ctx: AppContext, shift: ShiftRow): Promise<OpenShift> {
  const age = ctx.now().getTime() - Date.parse(shift.opened_at);
  return {
    id: shift.id,
    shiftNo: shift.shift_no,
    businessDate: shift.business_date,
    openedAt: shift.opened_at,
    openedBy: await userName(db, shift.opened_by),
    openingFloat: shift.opening_float,
    stale: age > STALE_HOURS * 3_600_000,
  };
}

export async function getOpenShift(ctx: AppContext): Promise<OpenShift | null> {
  const shift = await getOpenShiftTx(ctx.db, ctx);
  return shift ? toOpenShift(ctx.db, ctx, shift) : null;
}

/** What the last shift left in the drawer, to suggest as the next opening float. */
export async function getSuggestedFloat(ctx: AppContext): Promise<Money> {
  const last = await ctx.db
    .selectFrom('shift')
    .select('float_left')
    .where('device_id', '=', ctx.session.deviceId)
    .where('status', '=', 'closed')
    .orderBy('shift_no', 'desc')
    .executeTakeFirst();
  if (last?.float_left != null) return last.float_left;
  return (await getStoreSettingsTx(ctx.db, ctx.session.branchId)).defaultFloat;
}

const money = (message: string) =>
  z.number(message).int(message).min(0, 'Cannot be negative').max(100_000_000, 'Too large');

const cashCountSchema = z.object({
  notes: z.partialRecord(
    z.enum(PKR_NOTES.map(String) as [string, ...string[]]),
    z.number().int().min(0).max(10_000),
  ),
  coins: z.number().int().min(0).max(10_000_000),
});

function checkCount(
  count: CashCount | undefined | null,
  amount: Money,
  field: string,
): string | null {
  if (!count) return null;
  const total = countTotal(count);
  if (total !== amount) {
    throw new AppError('VALIDATION', `The notes add up to ${formatMoney(total)}`, {
      [field]: `The notes add up to ${formatMoney(total)}`,
    });
  }
  return JSON.stringify(count);
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

const openShiftSchema = z.object({
  openingFloat: money('Enter the cash in the drawer'),
  count: cashCountSchema.nullish(),
  /** The date the cashier confirmed, when the PC clock is days ahead of the last record. */
  confirmDate: z.string().nullish(),
});

export type OpenShiftInput = z.input<typeof openShiftSchema>;

/** Starts a shift on this till with the cash counted into the drawer. */
export async function openShift(ctx: AppContext, input: OpenShiftInput): Promise<OpenShift> {
  const data = parseInput(openShiftSchema, input);
  return ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'shift.open');
    const clock = await assertClockTx(trx, ctx);
    const date = today(ctx);
    if (clock.check.status === 'ahead') {
      if (data.confirmDate !== date) {
        throw new AppError(
          'NEEDS_CONFIRMATION',
          `Is today really ${formatDate(date)}? The last record was ${clock.check.days} days earlier.`,
          {},
          { confirm: 'date', date, days: clock.check.days, lastRecord: clock.highWater },
        );
      }
      await audit(trx, ctx, {
        action: 'clock.date_confirmed',
        entityType: 'device',
        entityId: ctx.session.deviceId,
        after: { date, highWater: clock.highWater },
      });
    }

    const open = await getOpenShiftTx(trx, ctx);
    if (open) throw new AppError('INVALID_STATE', `Shift ${open.shift_no} is already open`);
    const countJson = checkCount(data.count, data.openingFloat, 'openingFloat');

    const last = await trx
      .selectFrom('shift')
      .select(['shift_no', 'float_left'])
      .where('device_id', '=', ctx.session.deviceId)
      .orderBy('shift_no', 'desc')
      .executeTakeFirst();
    const now = timestamp(ctx);
    const row = {
      id: ctx.newId(),
      branch_id: ctx.session.branchId,
      device_id: ctx.session.deviceId,
      shift_no: (last?.shift_no ?? 0) + 1,
      business_date: date,
      status: 'open' as const,
      opened_by: ctx.session.userId,
      opened_at: now,
      opening_float: data.openingFloat,
      closed_by: null,
      closed_at: null,
      expected_cash: null,
      counted_cash: null,
      variance: null,
      float_left: null,
      count_json: countJson,
      close_note: null,
      created_at: now,
      updated_at: now,
    };
    await insertRow(trx, now, 'shift', row);
    await audit(trx, ctx, {
      action: 'shift.open',
      entityType: 'shift',
      entityId: row.id,
      after: { shiftNo: row.shift_no, openingFloat: row.opening_float },
    });
    if (last?.float_left != null && last.float_left !== data.openingFloat) {
      await audit(trx, ctx, {
        action: 'shift.float_mismatch',
        entityType: 'shift',
        entityId: row.id,
        before: { floatLeft: last.float_left },
        after: { openingFloat: data.openingFloat },
      });
    }
    await noteClockSuspectTx(trx, ctx, row.id, clock);
    await bumpClockTx(trx, ctx);
    return toOpenShift(trx, ctx, row);
  });
}

// ---------------------------------------------------------------------------
// Cash in and out
// ---------------------------------------------------------------------------

export const CASH_CATEGORIES = [
  'expense',
  'supplier',
  'staff',
  'owner',
  'bank',
  'change',
  'other',
] as const satisfies readonly CashMovementCategory[];

const cashMovementSchema = z.object({
  kind: z.enum(['pay_in', 'pay_out']),
  category: z.enum(CASH_CATEGORIES, 'Choose what it is for'),
  amount: money('Enter the amount').refine((v) => v > 0, 'Enter the amount'),
  note: requiredText(200, 'Say what it is for, e.g. "Tea for staff"'),
  approval: z.object({ userId: z.string(), pin: z.string() }).nullish(),
});

export type CashMovementInput = z.input<typeof cashMovementSchema>;

/** Cash put into or taken out of the drawer that isn't a sale (change, tea, a supplier). */
export async function recordCashMovement(
  ctx: AppContext,
  input: CashMovementInput,
): Promise<{ id: string; openDrawer: true }> {
  const data = parseInput(cashMovementSchema, input);
  const settings = await getStoreSettingsTx(ctx.db, ctx.session.branchId);
  const large = data.kind === 'pay_out' && data.amount > settings.payOutLimit;
  const approval = large ? await resolveApproval(ctx, data.approval, 'cash.pay_out_large') : null;

  return ctx.db.transaction().execute(async (trx) => {
    const { actor } = await authorizeTx(
      trx,
      ctx,
      data.kind === 'pay_in' ? 'cash.pay_in' : 'cash.pay_out',
    );
    const approvedBy = large
      ? (await authorizeTx(trx, ctx, 'cash.pay_out_large', approval)).approvedBy
      : null;
    const clock = await assertClockTx(trx, ctx);
    const shift = await requireOpenShiftTx(trx, ctx);
    await noteClockSuspectTx(trx, ctx, shift.id, clock);
    if (data.kind === 'pay_out') {
      const expected = await expectedCashTx(trx, shift.id);
      if (data.amount > expected) {
        // A blind count must stay blind: only those who may see expected cash get the figure.
        const message = can(actor.role, 'shift.view_expected')
          ? `Only ${formatMoney(Math.max(expected, 0))} should be in the drawer`
          : 'There isn’t that much cash in the drawer';
        throw new AppError('VALIDATION', message, { amount: message });
      }
    }
    const now = timestamp(ctx);
    const id = ctx.newId();
    const amount = data.kind === 'pay_in' ? data.amount : -data.amount;
    await insertRow(trx, now, 'cash_movement', {
      id,
      branch_id: ctx.session.branchId,
      device_id: ctx.session.deviceId,
      shift_id: shift.id,
      kind: data.kind,
      category: data.category,
      amount,
      note: data.note,
      user_id: ctx.session.userId,
      approved_by: approvedBy,
      created_at: now,
    });
    await audit(trx, ctx, {
      action: data.kind === 'pay_in' ? 'cash.pay_in' : 'cash.pay_out',
      entityType: 'cash_movement',
      entityId: id,
      after: { amount, category: data.category, note: data.note },
      approvedBy,
    });
    await bumpClockTx(trx, ctx);
    return { id, openDrawer: true as const };
  });
}

const noSaleSchema = z.object({
  reason: requiredText(200, 'Say why the drawer is being opened'),
  approval: z.object({ userId: z.string(), pin: z.string() }).nullish(),
});

/** Opens the drawer without a sale (e.g. to give change). Always logged. */
export async function recordNoSale(
  ctx: AppContext,
  input: { reason: string; approval?: ApprovalInput | null },
): Promise<{ openDrawer: true }> {
  const data = parseInput(noSaleSchema, input);
  const approval = await resolveApproval(ctx, data.approval, 'drawer.no_sale');
  await ctx.db.transaction().execute(async (trx) => {
    const { approvedBy } = await authorizeTx(trx, ctx, 'drawer.no_sale', approval);
    const shift = await requireOpenShiftTx(trx, ctx);
    await audit(trx, ctx, {
      action: 'drawer.no_sale',
      entityType: 'shift',
      entityId: shift.id,
      reason: data.reason,
      approvedBy,
    });
  });
  return { openDrawer: true };
}

// ---------------------------------------------------------------------------
// Totals (the X and Z reports)
// ---------------------------------------------------------------------------

export interface MethodTotals {
  /** Received for sales. */
  received: Money;
  /** Paid back for voids and returns (as a positive amount). */
  refunded: Money;
  net: Money;
}

export interface ShiftTotals {
  shift: {
    id: string;
    shiftNo: number;
    businessDate: string;
    status: 'open' | 'closed';
    openedAt: string;
    openedBy: string;
    closedAt: string | null;
    closedBy: string;
    openingFloat: Money;
    countedCash: Money | null;
    variance: Money | null;
    floatLeft: Money | null;
    note: string | null;
  };
  /** Completed sales that weren't voided. */
  sales: {
    count: number;
    gross: Money;
    discounts: Money;
    rounding: Money;
    total: Money;
    tax: Money;
    /** Cost of the goods sold, where known. */
    cost: Money | null;
  };
  voids: { count: number; total: Money };
  returns: { count: number; total: Money };
  payments: Record<PaymentMethod, MethodTotals>;
  walletByProvider: Record<string, Money>;
  cashIn: Money;
  cashOut: Money;
  cashByCategory: Record<string, Money>;
  /** Lines the owner should look at: sold above MRP, without recorded stock, Rx not seen. */
  flags: { aboveMrp: number; unrecorded: number; rxNotSeen: number };
  heldSales: number;
  /** Records were written while the clock read behind the last record (`clock.suspect`). */
  clockBehind: boolean;
  /** Null for staff counting blind, until the shift is closed. */
  expectedCash: Money | null;
}

export async function getShiftTotals(ctx: AppContext, shiftId: string): Promise<ShiftTotals> {
  const db = ctx.db;
  const actor = await actorTx(db, ctx);
  const shift = await db
    .selectFrom('shift')
    .selectAll()
    .where('id', '=', shiftId)
    .executeTakeFirst();
  if (!shift) throw new AppError('NOT_FOUND', 'Shift not found');

  const sales = await sql<{
    count: number;
    gross: number;
    discounts: number;
    rounding: number;
    total: number;
    tax: number;
    cost: number | null;
    unknown_cost: number;
  }>`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(gross_total), 0) AS gross,
           COALESCE(SUM(line_discount_total + bill_discount), 0) AS discounts,
           COALESCE(SUM(rounding), 0) AS rounding,
           COALESCE(SUM(total), 0) AS total,
           COALESCE(SUM(tax_total), 0) AS tax,
           SUM(cost_total) AS cost,
           COALESCE(SUM(cost_total IS NULL), 0) AS unknown_cost
    FROM sale s
    WHERE s.shift_id = ${shiftId}
      AND NOT EXISTS (SELECT 1 FROM sale_void v WHERE v.sale_id = s.id)
  `.execute(db);
  const voids = await sql<{ count: number; total: number }>`
    SELECT COUNT(*) AS count, COALESCE(SUM(s.total), 0) AS total
    FROM sale_void v JOIN sale s ON s.id = v.sale_id
    WHERE v.shift_id = ${shiftId}
  `.execute(db);
  const returns = await sql<{ count: number; total: number }>`
    SELECT COUNT(*) AS count, COALESCE(SUM(refund_total), 0) AS total
    FROM sale_return WHERE shift_id = ${shiftId}
  `.execute(db);
  const payments = await db
    .selectFrom('payment')
    .select(['method', 'doc_type', 'wallet_provider'])
    .select((eb) => eb.fn.sum<number>('amount').as('amount'))
    .where('shift_id', '=', shiftId)
    .groupBy(['method', 'doc_type', 'wallet_provider'])
    .execute();
  const movements = await db
    .selectFrom('cash_movement')
    .select(['kind', 'category'])
    .select((eb) => eb.fn.sum<number>('amount').as('amount'))
    .where('shift_id', '=', shiftId)
    .groupBy(['kind', 'category'])
    .execute();
  const flags = await sql<{ above_mrp: number; unrecorded: number; rx_not_seen: number }>`
    SELECT
      (SELECT COUNT(*) FROM sale_line l JOIN sale s ON s.id = l.sale_id
        WHERE s.shift_id = ${shiftId} AND l.above_mrp = 1) AS above_mrp,
      (SELECT COUNT(DISTINCT b.sale_line_id) FROM sale_line_batch b JOIN sale s ON s.id = b.sale_id
        WHERE s.shift_id = ${shiftId} AND b.pick = 'unrecorded') AS unrecorded,
      (SELECT COUNT(*) FROM sale WHERE shift_id = ${shiftId} AND rx_check = 'not_seen')
        AS rx_not_seen
  `.execute(db);
  const held = await db
    .selectFrom('sale_draft')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('device_id', '=', shift.device_id)
    .where('status', '=', 'held')
    .executeTakeFirstOrThrow();
  const clockSuspect = await db
    .selectFrom('audit_log')
    .select('id')
    .where('action', '=', 'clock.suspect')
    .where('entity_type', '=', 'shift')
    .where('entity_id', '=', shift.id)
    .executeTakeFirst();

  const methods: Record<PaymentMethod, MethodTotals> = {
    cash: { received: 0, refunded: 0, net: 0 },
    card: { received: 0, refunded: 0, net: 0 },
    wallet: { received: 0, refunded: 0, net: 0 },
    khata: { received: 0, refunded: 0, net: 0 },
  };
  const walletByProvider: Record<string, Money> = {};
  for (const p of payments) {
    const amount = Number(p.amount);
    const m = methods[p.method];
    if (p.doc_type === 'sale') m.received += amount;
    else m.refunded -= amount;
    m.net += amount;
    if (p.method === 'wallet' && p.wallet_provider) {
      walletByProvider[p.wallet_provider] = (walletByProvider[p.wallet_provider] ?? 0) + amount;
    }
  }
  let cashIn = 0;
  let cashOut = 0;
  const cashByCategory: Record<string, Money> = {};
  for (const m of movements) {
    const amount = Number(m.amount);
    if (m.kind === 'pay_in') cashIn += amount;
    else cashOut -= amount;
    cashByCategory[m.category] = (cashByCategory[m.category] ?? 0) + amount;
  }

  const s = sales.rows[0]!;
  const f = flags.rows[0]!;
  const showExpected = shift.status === 'closed' || can(actor.role, 'shift.view_expected');
  return {
    shift: {
      id: shift.id,
      shiftNo: shift.shift_no,
      businessDate: shift.business_date,
      status: shift.status,
      openedAt: shift.opened_at,
      openedBy: await userName(db, shift.opened_by),
      closedAt: shift.closed_at,
      closedBy: await userName(db, shift.closed_by),
      openingFloat: shift.opening_float,
      countedCash: shift.counted_cash,
      variance: shift.variance,
      floatLeft: shift.float_left,
      note: shift.close_note,
    },
    sales: {
      count: Number(s.count),
      gross: Number(s.gross),
      discounts: Number(s.discounts),
      rounding: Number(s.rounding),
      total: Number(s.total),
      tax: Number(s.tax),
      cost: Number(s.unknown_cost) > 0 || s.cost === null ? null : Number(s.cost),
    },
    voids: { count: Number(voids.rows[0]!.count), total: Number(voids.rows[0]!.total) },
    returns: { count: Number(returns.rows[0]!.count), total: Number(returns.rows[0]!.total) },
    payments: methods,
    walletByProvider,
    cashIn,
    cashOut,
    cashByCategory,
    flags: {
      aboveMrp: Number(f.above_mrp),
      unrecorded: Number(f.unrecorded),
      rxNotSeen: Number(f.rx_not_seen),
    },
    heldSales: Number(held.n),
    clockBehind: clockSuspect !== undefined,
    expectedCash: showExpected
      ? (shift.expected_cash ?? (await expectedCashTx(db, shift.id)))
      : null,
  };
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

const closeShiftSchema = z.object({
  shiftId: z.string().min(1),
  countedCash: money('Enter the cash counted'),
  count: cashCountSchema.nullish(),
  floatLeft: money('Enter the cash left in the drawer'),
  note: optionalText(500),
});

export type CloseShiftInput = z.input<typeof closeShiftSchema>;

export type CloseShiftResult =
  { status: 'needs_note'; variance: Money } | { status: 'closed'; totals: ShiftTotals };

/**
 * Closes the shift with the cash counted. The count is blind: expected cash is worked
 * out here from the records. A difference of Rs 100 or more needs a note; the first count
 * is logged before asking, so a recount after seeing the difference shows in the audit.
 */
export async function closeShift(
  ctx: AppContext,
  input: CloseShiftInput,
): Promise<CloseShiftResult> {
  const data = parseInput(closeShiftSchema, input);
  const result = await ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'shift.close');
    const shift = await requireOpenShiftTx(trx, ctx);
    if (shift.id !== data.shiftId) {
      throw new AppError('INVALID_STATE', 'This shift was already closed');
    }
    const inProgress = await trx
      .selectFrom('sale_draft')
      .select('id')
      .where('device_id', '=', ctx.session.deviceId)
      .where('status', '=', 'active')
      .where('line_count', '>', 0)
      .executeTakeFirst();
    if (inProgress) {
      throw new AppError('INVALID_STATE', 'Hold or finish the sale in progress first');
    }
    const countJson = checkCount(data.count, data.countedCash, 'countedCash');
    if (data.floatLeft > data.countedCash) {
      throw new AppError('VALIDATION', 'Can’t leave more than was counted', {
        floatLeft: 'More than the cash counted',
      });
    }

    const expected = await expectedCashTx(trx, shift.id);
    const variance = data.countedCash - expected;
    const settings = await getStoreSettingsTx(trx, ctx.session.branchId);
    if (Math.abs(variance) >= settings.varianceNoteAt && !data.note) {
      await audit(trx, ctx, {
        action: 'shift.count',
        entityType: 'shift',
        entityId: shift.id,
        after: { counted: data.countedCash, expected, variance },
      });
      return { status: 'needs_note' as const, variance };
    }

    const now = timestamp(ctx);
    await updateRow(trx, now, 'shift', shift.id, {
      status: 'closed',
      closed_by: ctx.session.userId,
      closed_at: now,
      expected_cash: expected,
      counted_cash: data.countedCash,
      variance,
      float_left: data.floatLeft,
      count_json: countJson ?? shift.count_json,
      close_note: data.note,
    });
    await audit(trx, ctx, {
      action: 'shift.close',
      entityType: 'shift',
      entityId: shift.id,
      after: {
        shiftNo: shift.shift_no,
        expected,
        counted: data.countedCash,
        variance,
        floatLeft: data.floatLeft,
      },
      reason: data.note,
    });
    await bumpClockTx(trx, ctx);
    return { status: 'closed' as const };
  });
  if (result.status === 'needs_note') return result;
  return { status: 'closed', totals: await getShiftTotals(ctx, data.shiftId) };
}

export interface ShiftListRow {
  id: string;
  shiftNo: number;
  businessDate: string;
  status: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  variance: Money | null;
}

/** Recent shifts on this till, newest first. */
export async function listShifts(ctx: AppContext, limit = 30): Promise<ShiftListRow[]> {
  const rows = await ctx.db
    .selectFrom('shift')
    .select(['id', 'shift_no', 'business_date', 'status', 'opened_at', 'closed_at', 'variance'])
    .where('device_id', '=', ctx.session.deviceId)
    .orderBy('shift_no', 'desc')
    .limit(limit)
    .execute();
  const actor = await actorTx(ctx.db, ctx);
  const showVariance = can(actor.role, 'shift.view_expected');
  return rows.map((r) => ({
    id: r.id,
    shiftNo: r.shift_no,
    businessDate: r.business_date,
    status: r.status,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    variance: showVariance ? r.variance : null,
  }));
}
