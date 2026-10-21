import {
  AppError,
  generateRecoveryCode,
  hashPin,
  hashSecret,
  isLocked,
  normalizeRecoveryCode,
  verifySecret,
  type ApprovalKind,
  type UserRole,
} from '@app/core';
import { z } from 'zod';
import {
  timestamp,
  withSession,
  type AppContext,
  type ServiceContext,
  type Session,
} from '../context';
import { META, getMeta, setMeta } from '../meta';
import { parseInput } from '../validation';
import { audit, updateRow } from '../writes';
import { authorizeTx, actorTx, checkUserPin, verifyApprover, type PinUser } from './guards';
import { checkNewPin, pinText } from './pin-input';
import { loadDevice } from './setup';

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export interface LoginUser {
  id: string;
  name: string;
  role: UserRole;
  hasPin: boolean;
  /** Set while too many wrong PINs keep this user out. */
  lockedUntil: string | null;
}

/** Active staff for the login screen, owners first, then by name. */
export async function listLoginUsers(ctx: ServiceContext): Promise<LoginUser[]> {
  const rows = await ctx.db
    .selectFrom('app_user as u')
    .leftJoin('pin_attempt as a', 'a.user_id', 'u.id')
    .select(['u.id', 'u.name', 'u.role', 'u.pin_hash', 'a.locked_until'])
    .where('u.is_active', '=', 1)
    .execute();
  const order: Record<UserRole, number> = { owner: 0, pharmacist: 1, cashier: 2, inventory: 3 };
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      hasPin: r.pin_hash !== null,
      lockedUntil: isLocked(r.locked_until, ctx.now()) ? r.locked_until : null,
    }))
    .sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));
}

async function requireDevice(ctx: ServiceContext) {
  const device = await loadDevice(ctx);
  if (!device) throw new AppError('NOT_SET_UP', 'This till isn’t set up yet');
  return device;
}

async function activeUser(ctx: ServiceContext, userId: string): Promise<PinUser> {
  const user = await ctx.db
    .selectFrom('app_user')
    .select(['id', 'name', 'role', 'pin_hash', 'is_active'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user || user.is_active !== 1) {
    throw new AppError('NOT_FOUND', 'Choose your name', { userId: 'Choose your name' });
  }
  return user;
}

const loginSchema = z.object({ userId: z.string().min(1, 'Choose your name'), pin: pinText });
export type LoginInput = z.input<typeof loginSchema>;

/** Checks a user's PIN and starts their session on this till. */
export async function login(ctx: ServiceContext, input: LoginInput): Promise<Session> {
  const data = parseInput(loginSchema, input);
  const device = await requireDevice(ctx);
  const user = await activeUser(ctx, data.userId);
  await checkUserPin(ctx, device, user, data.pin);

  const session: Session = { ...device, userId: user.id };
  await ctx.db.transaction().execute(async (trx) => {
    await audit(trx, withSession(ctx, session), {
      action: 'auth.login',
      entityType: 'app_user',
      entityId: user.id,
    });
  });
  return session;
}

/** Ends the session (the open sale stays as a draft for the next login). */
export async function logout(ctx: AppContext): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    await audit(trx, ctx, {
      action: 'auth.logout',
      entityType: 'app_user',
      entityId: ctx.session.userId,
    });
  });
}

// ---------------------------------------------------------------------------
// The owner's PIN and recovery code
// ---------------------------------------------------------------------------

const newPinInput = z
  .object({ pin: pinText, pinRepeat: pinText })
  .superRefine((d, c) => checkNewPin(c, d.pin, d.pinRepeat, { owner: true, field: 'pin' }));

/** Whether the first owner still needs a PIN (a till set up before PIN login existed). */
export async function ownerNeedsPin(ctx: ServiceContext): Promise<boolean> {
  const ownerId = await getMeta(ctx.db, META.ownerUserId);
  if (!ownerId) return false;
  const owner = await ctx.db
    .selectFrom('app_user')
    .select('pin_hash')
    .where('id', '=', ownerId)
    .executeTakeFirst();
  return !!owner && owner.pin_hash === null;
}

/**
 * Sets the first owner's PIN on a till set up before PIN login existed, and creates the
 * recovery code. Refused once the owner has a PIN.
 */
export async function setInitialOwnerPin(
  ctx: ServiceContext,
  input: z.input<typeof newPinInput>,
): Promise<{ session: Session; recoveryCode: string }> {
  const data = parseInput(newPinInput, input);
  const device = await requireDevice(ctx);
  const ownerId = await getMeta(ctx.db, META.ownerUserId);
  if (!ownerId || !(await ownerNeedsPin(ctx))) {
    throw new AppError('INVALID_STATE', 'The owner already has a PIN');
  }
  const recoveryCode = generateRecoveryCode();
  const pinHash = await hashPin(data.pin, ctx.pinIterations);
  const recoveryHash = await hashSecret(normalizeRecoveryCode(recoveryCode), ctx.pinIterations);

  const session: Session = { ...device, userId: ownerId };
  const app = withSession(ctx, session);
  await ctx.db.transaction().execute(async (trx) => {
    const owner = await trx
      .selectFrom('app_user')
      .select('pin_hash')
      .where('id', '=', ownerId)
      .executeTakeFirstOrThrow();
    if (owner.pin_hash !== null) throw new AppError('INVALID_STATE', 'The owner already has a PIN');
    await updateRow(trx, timestamp(ctx), 'app_user', ownerId, { pin_hash: pinHash });
    await setMeta(trx, META.recoveryHash, recoveryHash);
    await audit(trx, app, { action: 'auth.pin_set', entityType: 'app_user', entityId: ownerId });
  });
  return { session, recoveryCode };
}

const recoverySchema = z
  .object({
    recoveryCode: z.string('Enter the recovery code').trim().min(1, 'Enter the recovery code'),
    pin: pinText,
    pinRepeat: pinText,
  })
  .superRefine((d, c) => checkNewPin(c, d.pin, d.pinRepeat, { owner: true, field: 'pin' }));

/**
 * Resets the first owner's forgotten PIN with the recovery code. The code works once:
 * a new one is returned to write down.
 */
export async function resetOwnerPinWithRecovery(
  ctx: ServiceContext,
  input: z.input<typeof recoverySchema>,
): Promise<{ recoveryCode: string }> {
  const data = parseInput(recoverySchema, input);
  const device = await requireDevice(ctx);
  const ownerId = await getMeta(ctx.db, META.ownerUserId);
  const stored = await getMeta(ctx.db, META.recoveryHash);
  const typed = normalizeRecoveryCode(data.recoveryCode);
  if (!ownerId || !stored || !typed || !(await verifySecret(typed, stored))) {
    throw new AppError('WRONG_PIN', 'That recovery code is not right', {
      recoveryCode: 'Check the code you wrote down at setup',
    });
  }
  const recoveryCode = generateRecoveryCode();
  const pinHash = await hashPin(data.pin, ctx.pinIterations);
  const recoveryHash = await hashSecret(normalizeRecoveryCode(recoveryCode), ctx.pinIterations);

  await ctx.db.transaction().execute(async (trx) => {
    // The code may have been used meanwhile (two tabs): it must still be the same one.
    if ((await getMeta(trx, META.recoveryHash)) !== stored) {
      throw new AppError('INVALID_STATE', 'The recovery code was just used. Try again.');
    }
    await updateRow(trx, timestamp(ctx), 'app_user', ownerId, { pin_hash: pinHash, is_active: 1 });
    await trx.deleteFrom('pin_attempt').where('user_id', '=', ownerId).execute();
    await setMeta(trx, META.recoveryHash, recoveryHash);
    await audit(trx, withSession(ctx, { ...device, userId: ownerId }), {
      action: 'auth.recovery_used',
      entityType: 'app_user',
      entityId: ownerId,
    });
  });
  return { recoveryCode };
}

// ---------------------------------------------------------------------------
// Changing your own PIN
// ---------------------------------------------------------------------------

const changePinSchema = z.object({ currentPin: pinText, pin: pinText, pinRepeat: pinText });

export async function changeOwnPin(
  ctx: AppContext,
  input: z.input<typeof changePinSchema>,
): Promise<void> {
  const data = parseInput(changePinSchema, input);
  const user = await activeUser(ctx, ctx.session.userId);
  parseInput(
    z
      .object({ pin: z.string(), pinRepeat: z.string() })
      .superRefine((d, c) =>
        checkNewPin(c, d.pin, d.pinRepeat, { owner: user.role === 'owner', field: 'pin' }),
      ),
    data,
  );
  try {
    await checkUserPin(ctx, ctx.session, user, data.currentPin);
  } catch (error) {
    if (error instanceof AppError && error.code === 'WRONG_PIN') {
      throw new AppError('WRONG_PIN', error.message, { currentPin: error.message });
    }
    throw error;
  }
  const pinHash = await hashPin(data.pin, ctx.pinIterations);
  await ctx.db.transaction().execute(async (trx) => {
    await actorTx(trx, ctx);
    await updateRow(trx, timestamp(ctx), 'app_user', user.id, { pin_hash: pinHash });
    await audit(trx, ctx, { action: 'auth.pin_change', entityType: 'app_user', entityId: user.id });
  });
}

// ---------------------------------------------------------------------------
// Approvals for the sale in progress
// ---------------------------------------------------------------------------

const grantSchema = z.object({
  draftId: z.string().min(1),
  userId: z.string().min(1, 'Choose who is approving'),
  pin: pinText,
  permission: z.enum([
    'sale.discount',
    'sale.price_override',
    'sale.controlled',
  ] as const satisfies readonly ApprovalKind[]),
  /** For a discount: the smallest cap (bp) that covers it. */
  needBp: z.number().int().min(0).max(10_000).optional(),
});

export type GrantApprovalInput = z.input<typeof grantSchema>;

/**
 * Records that a pharmacist or the owner approved something on the sale being rung up
 * (a discount above the cashier's cap, a price change, a controlled drug). The approval
 * stays with the draft and is used when the sale completes.
 */
export async function grantApproval(
  ctx: AppContext,
  input: GrantApprovalInput,
): Promise<{ approverName: string; limitBp: number | null }> {
  const data = parseInput(grantSchema, input);
  const need =
    data.permission === 'sale.discount' ? { discountBp: data.needBp ?? 0 } : data.permission;
  const approval = await verifyApprover(ctx, { userId: data.userId, pin: data.pin }, need);
  const limitBp = data.permission === 'sale.discount' ? approval.capBp : null;

  await ctx.db.transaction().execute(async (trx) => {
    const draft = await trx
      .selectFrom('sale_draft')
      .select(['id'])
      .where('id', '=', data.draftId)
      .where('device_id', '=', ctx.session.deviceId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!draft) throw new AppError('INVALID_STATE', 'This sale is no longer open');
    if (data.permission !== 'sale.discount') {
      // The approver must still be allowed (re-read inside the transaction).
      await authorizeTx(trx, ctx, data.permission, approval);
    }
    await trx
      .insertInto('draft_approval')
      .values({
        id: ctx.newId(),
        draft_id: draft.id,
        permission: data.permission,
        approver_id: approval.userId,
        limit_bp: limitBp,
        created_at: timestamp(ctx),
      })
      .execute();
    await audit(trx, ctx, {
      action: 'auth.approval',
      entityType: 'sale_draft',
      entityId: draft.id,
      after: { permission: data.permission, limitBp },
      approvedBy: approval.userId,
    });
  });
  return { approverName: approval.name, limitBp };
}
