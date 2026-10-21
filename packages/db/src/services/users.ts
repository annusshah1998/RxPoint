import { AppError, USER_ROLES, hashPin, isLocked, nameKey, type UserRole } from '@app/core';
import { z } from 'zod';
import { timestamp, type AppContext } from '../context';
import { parseInput, requiredText } from '../validation';
import { audit, insertRow, updateRow, type Tx } from '../writes';
import { authorizeTx } from './guards';
import { checkNewPin, pinText } from './pin-input';

export interface StaffUser {
  id: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  hasPin: boolean;
  lockedUntil: string | null;
}

/** Everyone, including switched-off accounts (owner only). */
export async function listUsers(ctx: AppContext): Promise<StaffUser[]> {
  await ctx.db.transaction().execute((trx) => authorizeTx(trx, ctx, 'users.manage'));
  const rows = await ctx.db
    .selectFrom('app_user as u')
    .leftJoin('pin_attempt as a', 'a.user_id', 'u.id')
    .select(['u.id', 'u.name', 'u.role', 'u.is_active', 'u.pin_hash', 'a.locked_until'])
    .orderBy('u.is_active', 'desc')
    .orderBy('u.name')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    isActive: r.is_active === 1,
    hasPin: r.pin_hash !== null,
    lockedUntil: isLocked(r.locked_until, ctx.now()) ? r.locked_until : null,
  }));
}

const roleSchema = z.enum(USER_ROLES, 'Choose a role');

const createUserSchema = z
  .object({
    name: requiredText(80, 'Enter the person’s name'),
    role: roleSchema,
    pin: pinText,
    pinRepeat: pinText,
  })
  .superRefine((d, c) =>
    checkNewPin(c, d.pin, d.pinRepeat, { owner: d.role === 'owner', field: 'pin' }),
  );

export type CreateUserInput = z.input<typeof createUserSchema>;

/** Two active people with the same name would be confusing on the login screen. */
async function assertNameFree(trx: Tx, name: string, exceptId: string | null) {
  const clash = await trx
    .selectFrom('app_user')
    .select(['id', 'name'])
    .where('is_active', '=', 1)
    .execute();
  if (clash.some((u) => u.id !== exceptId && nameKey(u.name) === nameKey(name))) {
    throw new AppError('DUPLICATE', `There is already someone called ${name}`, {
      name: 'Add a surname or initial',
    });
  }
}

export async function createUser(ctx: AppContext, input: CreateUserInput): Promise<StaffUser> {
  const data = parseInput(createUserSchema, input);
  const pinHash = await hashPin(data.pin, ctx.pinIterations);
  return ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'users.manage');
    await assertNameFree(trx, data.name, null);
    const now = timestamp(ctx);
    const id = ctx.newId();
    await insertRow(trx, now, 'app_user', {
      id,
      name: data.name,
      role: data.role,
      pin_hash: pinHash,
      is_active: 1,
      created_at: now,
      updated_at: now,
    });
    await audit(trx, ctx, {
      action: 'user.create',
      entityType: 'app_user',
      entityId: id,
      after: { name: data.name, role: data.role },
    });
    return {
      id,
      name: data.name,
      role: data.role,
      isActive: true,
      hasPin: true,
      lockedUntil: null,
    };
  });
}

const updateUserSchema = z.object({
  name: requiredText(80, 'Enter the person’s name').optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
});

export type UpdateUserInput = z.input<typeof updateUserSchema>;

/**
 * Renames, changes the role of, or switches off an account. The last active owner can't be
 * demoted or switched off, and you can't switch yourself off.
 */
export async function updateUser(
  ctx: AppContext,
  id: string,
  input: UpdateUserInput,
): Promise<void> {
  const data = parseInput(updateUserSchema, input);
  await ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'users.manage');
    const before = await trx
      .selectFrom('app_user')
      .select(['id', 'name', 'role', 'is_active'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!before) throw new AppError('NOT_FOUND', 'User not found');

    const after = {
      name: data.name ?? before.name,
      role: data.role ?? before.role,
      is_active: data.isActive === undefined ? before.is_active : data.isActive ? 1 : 0,
    } as const;

    if (after.is_active === 0 && id === ctx.session.userId) {
      throw new AppError('INVALID_STATE', 'You can’t switch off your own account', {
        isActive: 'Ask another owner',
      });
    }
    const losesOwner =
      before.role === 'owner' &&
      before.is_active === 1 &&
      (after.role !== 'owner' || after.is_active === 0);
    if (losesOwner) {
      const owners = await trx
        .selectFrom('app_user')
        .select('id')
        .where('role', '=', 'owner')
        .where('is_active', '=', 1)
        .execute();
      if (owners.length <= 1) {
        throw new AppError('INVALID_STATE', 'The store needs at least one owner', {
          role: 'Make someone else an owner first',
        });
      }
    }
    if (after.is_active === 1) await assertNameFree(trx, after.name, id);

    const changed = await updateRow(trx, timestamp(ctx), 'app_user', id, after);
    if (!changed) return;
    const action =
      before.is_active === 1 && after.is_active === 0
        ? 'user.deactivate'
        : before.role !== after.role
          ? 'user.role_change'
          : 'user.update';
    await audit(trx, ctx, {
      action,
      entityType: 'app_user',
      entityId: id,
      before: { name: before.name, role: before.role, isActive: before.is_active === 1 },
      after: { name: after.name, role: after.role, isActive: after.is_active === 1 },
    });
  });
}

const resetPinSchema = z.object({ pin: pinText, pinRepeat: pinText });

/** Sets a new PIN for someone who forgot theirs, and lifts any lockout. */
export async function resetUserPin(
  ctx: AppContext,
  id: string,
  input: z.input<typeof resetPinSchema>,
): Promise<void> {
  const data = parseInput(resetPinSchema, input);
  const user = await ctx.db
    .selectFrom('app_user')
    .select(['id', 'role'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!user) throw new AppError('NOT_FOUND', 'User not found');
  parseInput(
    z
      .object({ pin: z.string(), pinRepeat: z.string() })
      .superRefine((d, c) =>
        checkNewPin(c, d.pin, d.pinRepeat, { owner: user.role === 'owner', field: 'pin' }),
      ),
    data,
  );
  const pinHash = await hashPin(data.pin, ctx.pinIterations);
  await ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'users.manage');
    await updateRow(trx, timestamp(ctx), 'app_user', id, { pin_hash: pinHash });
    await trx.deleteFrom('pin_attempt').where('user_id', '=', id).execute();
    await audit(trx, ctx, { action: 'auth.pin_reset', entityType: 'app_user', entityId: id });
  });
}

/** Lifts a lockout after too many wrong PINs. */
export async function unlockUser(ctx: AppContext, id: string): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'users.manage');
    const removed = await trx.deleteFrom('pin_attempt').where('user_id', '=', id).execute();
    if (Number(removed[0]?.numDeletedRows ?? 0) === 0) return;
    await audit(trx, ctx, { action: 'auth.unlock', entityType: 'app_user', entityId: id });
  });
}
