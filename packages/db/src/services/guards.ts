import {
  AppError,
  approverPhrase,
  assessClock,
  can,
  effectiveToday,
  expectedCash,
  formatExpiry,
  isApprovable,
  isLocked,
  laterTimestamp,
  localDate,
  localTime,
  lockUntil,
  nextSeq,
  rolesThatCan,
  verifyPin,
  type ApprovalKind,
  type ClockStatus,
  type IsoDate,
  type Money,
  type Permission,
  type UserRole,
} from '@app/core';
import { timestamp, withSession, type AppContext, type ServiceContext } from '../context';
import type { Db } from '../executor';
import { META, deleteMeta, getMeta, setMeta } from '../meta';
import type { ShiftRow } from '../schema';
import { audit, type Tx } from '../writes';
import { getStoreSettingsTx } from './settings';

/*
 * Checks shared by the services. The `…Tx` helpers run inside the caller's transaction.
 * PIN checks are slow on purpose (PBKDF2), so they run before the transaction starts:
 * the till has one database connection and a slow transaction would freeze it.
 */

// ---------------------------------------------------------------------------
// PINs and lockout
// ---------------------------------------------------------------------------

export interface PinUser {
  id: string;
  name: string;
  role: UserRole;
  pin_hash: string | null;
}

/**
 * Checks a user's PIN, counting wrong ones (in their own small transaction, so the count
 * sticks even though the caller then fails). Five wrong in a row locks the user for a minute.
 */
export async function checkUserPin(
  ctx: ServiceContext,
  where: { branchId: string; deviceId: string },
  user: PinUser,
  pin: string,
): Promise<void> {
  const attempt = await ctx.db
    .selectFrom('pin_attempt')
    .select(['failed_count', 'locked_until'])
    .where('user_id', '=', user.id)
    .executeTakeFirst();
  if (attempt && isLocked(attempt.locked_until, ctx.now())) {
    throw lockedError(ctx, attempt.locked_until!);
  }
  if (!user.pin_hash) {
    throw new AppError('INVALID_STATE', `${user.name} has no PIN yet. Ask the owner to set one.`);
  }

  if (await verifyPin(pin, user.pin_hash)) {
    if (attempt) await ctx.db.deleteFrom('pin_attempt').where('user_id', '=', user.id).execute();
    return;
  }

  const failed = await ctx.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('pin_attempt')
      .select('failed_count')
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    const count = (row?.failed_count ?? 0) + 1;
    const until = lockUntil(count, ctx.now());
    const values = {
      failed_count: count,
      locked_until: until?.toISOString() ?? null,
      updated_at: timestamp(ctx),
    };
    await trx
      .insertInto('pin_attempt')
      .values({ user_id: user.id, ...values })
      .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
      .execute();
    if (until) {
      await audit(trx, withSession(ctx, { ...where, userId: user.id }), {
        action: 'auth.lockout',
        entityType: 'app_user',
        entityId: user.id,
        after: { failedCount: count, lockedUntil: values.locked_until },
      });
    }
    return { count, until };
  });

  if (failed.until) throw lockedError(ctx, failed.until.toISOString());
  const left = 5 - (failed.count % 5);
  const message = `Wrong PIN — ${left} ${left === 1 ? 'try' : 'tries'} left`;
  throw new AppError('WRONG_PIN', message, { pin: message });
}

function lockedError(ctx: ServiceContext, until: string): AppError {
  const at = localTime(new Date(until), ctx.timeZone);
  const message = `Too many wrong PINs. Try again at ${at}.`;
  return new AppError('LOCKED', message, { pin: message });
}

// ---------------------------------------------------------------------------
// Permissions and approvals
// ---------------------------------------------------------------------------

/** A PIN typed by someone else to allow what the acting user can't do alone. */
export interface ApprovalInput {
  userId: string;
  pin: string;
}

/** An approver whose PIN has been checked. */
export interface Approval {
  userId: string;
  name: string;
  role: UserRole;
  /** The approver's own discount cap, in basis points. */
  capBp: number;
}

/**
 * Checks an approver's PIN (outside any transaction) and that they may approve `need`.
 * A wrong PIN counts against the approver, not the cashier.
 */
export async function verifyApprover(
  ctx: AppContext,
  input: ApprovalInput,
  need: ApprovalKind | { discountBp: number },
): Promise<Approval> {
  if (input.userId === ctx.session.userId) {
    throw new AppError('FORBIDDEN', 'Someone else has to approve this', {
      userId: 'Choose another person',
    });
  }
  const user = await ctx.db
    .selectFrom('app_user')
    .select(['id', 'name', 'role', 'pin_hash', 'is_active'])
    .where('id', '=', input.userId)
    .executeTakeFirst();
  if (!user || user.is_active !== 1) {
    throw new AppError('NOT_FOUND', 'Choose who is approving', { userId: 'Choose a person' });
  }
  await checkUserPin(ctx, ctx.session, user, input.pin);

  const settings = await getStoreSettingsTx(ctx.db, ctx.session.branchId);
  const capBp = Math.max(settings.discountCapBp[user.role], settings.defaultDiscountBp);
  if (typeof need === 'object') {
    if (capBp < need.discountBp) {
      throw new AppError('FORBIDDEN', `${user.name} can give at most ${capBp / 100}% discount`, {
        userId: 'Can’t approve this much',
      });
    }
  } else if (need !== 'sale.discount' && !can(user.role, need)) {
    throw new AppError('FORBIDDEN', `${user.name} can’t approve this`, {
      userId: `Needs ${approverPhrase(rolesThatCan(need))}`,
    });
  }
  return { userId: user.id, name: user.name, role: user.role, capBp };
}

/** Verifies an optional approval before a service's transaction starts. */
export async function resolveApproval(
  ctx: AppContext,
  input: ApprovalInput | null | undefined,
  need: ApprovalKind,
): Promise<Approval | null> {
  return input ? verifyApprover(ctx, input, need) : null;
}

export interface Actor {
  id: string;
  name: string;
  role: UserRole;
}

/** The acting user, read fresh: a role change or switch-off applies immediately. */
export async function actorTx(trx: Tx | Db, ctx: AppContext): Promise<Actor> {
  const actor = await trx
    .selectFrom('app_user')
    .select(['id', 'name', 'role', 'is_active'])
    .where('id', '=', ctx.session.userId)
    .executeTakeFirst();
  if (!actor || actor.is_active !== 1) {
    throw new AppError('FORBIDDEN', 'Your account is switched off. Ask the owner.');
  }
  return { id: actor.id, name: actor.name, role: actor.role };
}

/**
 * Checks, inside the transaction, that the acting user may do `permission`, or that a
 * verified approver may. Returns who approved (null when no one had to).
 */
export async function authorizeTx(
  trx: Tx,
  ctx: AppContext,
  permission: Permission,
  approval?: Approval | null,
): Promise<{ actor: Actor; approvedBy: string | null }> {
  const actor = await actorTx(trx, ctx);
  if (can(actor.role, permission)) return { actor, approvedBy: null };
  const who = approverPhrase(rolesThatCan(permission));
  if (!isApprovable(permission)) {
    throw new AppError('FORBIDDEN', `Only ${who} can do this`, {}, { permission });
  }
  if (approval && approval.userId !== actor.id && (await canStill(trx, approval, permission))) {
    return { actor, approvedBy: approval.userId };
  }
  throw new AppError('NEEDS_APPROVAL', `Needs a PIN from ${who}`, {}, { permission });
}

/** An approver checked before the transaction may have been switched off since. */
async function canStill(trx: Tx, approval: Approval, permission: Permission): Promise<boolean> {
  const row = await trx
    .selectFrom('app_user')
    .select(['role', 'is_active'])
    .where('id', '=', approval.userId)
    .executeTakeFirst();
  return !!row && row.is_active === 1 && can(row.role, permission);
}

// ---------------------------------------------------------------------------
// Shift
// ---------------------------------------------------------------------------

export async function getOpenShiftTx(trx: Tx | Db, ctx: AppContext): Promise<ShiftRow | null> {
  const shift = await trx
    .selectFrom('shift')
    .selectAll()
    .where('device_id', '=', ctx.session.deviceId)
    .where('status', '=', 'open')
    .executeTakeFirst();
  return shift ?? null;
}

export async function requireOpenShiftTx(trx: Tx, ctx: AppContext): Promise<ShiftRow> {
  const shift = await getOpenShiftTx(trx, ctx);
  if (!shift) throw new AppError('NO_SHIFT', 'Open a shift before selling');
  return shift;
}

/** What should be in the drawer, from the records: float + cash payments + pay-ins/outs. */
export async function expectedCashTx(trx: Tx | Db, shiftId: string): Promise<Money> {
  const shift = await trx
    .selectFrom('shift')
    .select('opening_float')
    .where('id', '=', shiftId)
    .executeTakeFirstOrThrow();
  const payments = await trx
    .selectFrom('payment')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount'), eb.lit(0)).as('total'))
    .where('shift_id', '=', shiftId)
    .where('method', '=', 'cash')
    .executeTakeFirstOrThrow();
  const movements = await trx
    .selectFrom('cash_movement')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount'), eb.lit(0)).as('total'))
    .where('shift_id', '=', shiftId)
    .executeTakeFirstOrThrow();
  return expectedCash(shift.opening_float, Number(payments.total), Number(movements.total));
}

// ---------------------------------------------------------------------------
// Document numbers
// ---------------------------------------------------------------------------

/** The next invoice or return number for this till. Call inside the writing transaction. */
export async function nextDocSeqTx(
  trx: Tx,
  ctx: AppContext,
  kind: 'sale' | 'return',
): Promise<number> {
  const max =
    kind === 'sale'
      ? await trx
          .selectFrom('sale')
          .select((eb) => eb.fn.max('invoice_seq').as('max'))
          .where('device_id', '=', ctx.session.deviceId)
          .executeTakeFirst()
      : await trx
          .selectFrom('sale_return')
          .select((eb) => eb.fn.max('return_seq').as('max'))
          .where('device_id', '=', ctx.session.deviceId)
          .executeTakeFirst();
  const floor = await getMeta(trx, kind === 'sale' ? META.invoiceFloor : META.returnFloor);
  return nextSeq(max?.max ?? null, floor ? Number(floor) : null);
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface ClockState {
  check: ClockStatus;
  highWater: string | null;
  /** Someone approved working with this clock. */
  overridden: boolean;
}

export async function clockStateTx(trx: Tx | Db, ctx: ServiceContext): Promise<ClockState> {
  const highWater = await getMeta(trx, META.clockHighWater);
  const overridden = (await getMeta(trx, META.clockOverride)) !== null;
  return {
    check: assessClock(ctx.now(), highWater, { buildTime: ctx.buildTime }),
    highWater,
    overridden,
  };
}

/** Whether this clock state stops documents being written (unless overridden). */
export function clockBlocks(check: ClockStatus): boolean {
  return (
    check.status === 'implausible' || (check.status === 'behind' && check.severity === 'block')
  );
}

/** Refuses to write documents with a clock that is certainly wrong, unless someone approved it. */
export async function assertClockTx(trx: Tx, ctx: ServiceContext): Promise<ClockState> {
  const state = await clockStateTx(trx, ctx);
  if (state.check.status === 'ok' && state.overridden) {
    await deleteMeta(trx, META.clockOverride);
    return { ...state, overridden: false };
  }
  if (!clockBlocks(state.check) || state.overridden) return state;
  throw new AppError('CLOCK_WRONG', clockMessage(ctx, state), {}, { clock: state.check });
}

export function clockMessage(ctx: ServiceContext, state: ClockState): string {
  const shown = formatExpiry(localDate(ctx.now(), ctx.timeZone));
  if (state.check.status === 'implausible') {
    return `The computer’s date (${shown}) can’t be right. Fix the date in Windows, then try again.`;
  }
  if (state.check.status === 'behind') {
    const last = state.highWater
      ? formatExpiry(localDate(new Date(state.highWater), ctx.timeZone))
      : '';
    return (
      `The computer’s date (${shown}) is earlier than the last record (${last}). ` +
      'Fix the date and time in Windows, or ask a pharmacist or the owner to approve.'
    );
  }
  return '';
}

/** Records that documents were written now, so a clock moved back later is noticed. */
export async function bumpClockTx(trx: Tx, ctx: ServiceContext): Promise<void> {
  const current = await getMeta(trx, META.clockHighWater);
  const next = laterTimestamp(current, timestamp(ctx));
  if (next !== current) await setMeta(trx, META.clockHighWater, next);
}

/** The business date: today, but never earlier than the last record's date. */
export async function effectiveTodayTx(trx: Tx | Db, ctx: ServiceContext): Promise<IsoDate> {
  return effectiveToday(ctx.now(), await getMeta(trx, META.clockHighWater), ctx.timeZone);
}
