import {
  AppError,
  generateRecoveryCode,
  hashPin,
  hashSecret,
  nameKey,
  normalizeRecoveryCode,
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
import { META, getMeta } from '../meta';
import { optionalText, parseInput, requiredText } from '../validation';
import { audit, insertRow } from '../writes';
import { checkNewPin, pinText } from './pin-input';

export const setupInputSchema = z
  .object({
    pharmacyName: requiredText(120, 'Enter the pharmacy name'),
    address: optionalText(200),
    phone: optionalText(40),
    tillCode: requiredText(10, 'Enter a short code for this till, e.g. T1')
      .transform((v) => v.toUpperCase())
      .refine(
        (v) => /^[A-Z][A-Z0-9]{0,9}$/.test(v),
        'Use letters and digits, starting with a letter',
      ),
    ownerName: requiredText(80, 'Enter the owner’s name'),
    ownerPin: pinText,
    ownerPinRepeat: pinText,
  })
  .superRefine((d, ctx) =>
    checkNewPin(ctx, d.ownerPin, d.ownerPinRepeat, { owner: true, field: 'ownerPin' }),
  );

export type SetupInput = z.input<typeof setupInputSchema>;

/** Which branch and till this installation is, or null if setup hasn't run yet. */
export async function loadDevice(
  ctx: ServiceContext,
): Promise<{ branchId: string; deviceId: string } | null> {
  const branchId = await getMeta(ctx.db, META.branchId);
  const deviceId = await getMeta(ctx.db, META.deviceId);
  return branchId && deviceId ? { branchId, deviceId } : null;
}

export interface SetupResult {
  /** The owner, logged in. */
  session: Session;
  /** Shown once: lets the owner reset a forgotten PIN. Only its hash is stored. */
  recoveryCode: string;
}

/** First run: creates the store, this till and the owner account with a PIN. */
export async function setupStore(ctx: ServiceContext, input: SetupInput): Promise<SetupResult> {
  const data = parseInput(setupInputSchema, input);
  if (await loadDevice(ctx)) throw new AppError('INVALID_STATE', 'This till is already set up');

  const recoveryCode = generateRecoveryCode();
  const pinHash = await hashPin(data.ownerPin, ctx.pinIterations);
  const recoveryHash = await hashSecret(normalizeRecoveryCode(recoveryCode), ctx.pinIterations);

  const now = timestamp(ctx);
  const session: Session = { branchId: ctx.newId(), deviceId: ctx.newId(), userId: ctx.newId() };
  const app: AppContext = withSession(ctx, session);

  await ctx.db.transaction().execute(async (trx) => {
    await insertRow(trx, now, 'branch', {
      id: session.branchId,
      code: 'B1',
      name: data.pharmacyName,
      address: data.address,
      phone: data.phone,
      ntn: null,
      strn: null,
      drug_license_no: null,
      created_at: now,
      updated_at: now,
    });
    await insertRow(trx, now, 'device', {
      id: session.deviceId,
      branch_id: session.branchId,
      code: data.tillCode,
      name: `Till ${data.tillCode}`,
      created_at: now,
      updated_at: now,
    });
    await insertRow(trx, now, 'app_user', {
      id: session.userId,
      name: data.ownerName,
      role: 'owner',
      pin_hash: pinHash,
      is_active: 1,
      created_at: now,
      updated_at: now,
    });
    // Rates for medicines need confirming with a tax adviser, so start with one
    // zero-rate class and let the owner add the real ones.
    await insertRow(trx, now, 'tax_class', {
      id: ctx.newId(),
      name: 'No tax',
      rate_bp: 0,
      is_active: 1,
      created_at: now,
      updated_at: now,
    });
    await trx
      .insertInto('local_meta')
      .values([
        { key: META.branchId, value: session.branchId },
        { key: META.deviceId, value: session.deviceId },
        { key: META.ownerUserId, value: session.userId },
        { key: META.recoveryHash, value: recoveryHash },
      ])
      .execute();
    await audit(trx, app, {
      action: 'store.setup',
      entityType: 'branch',
      entityId: session.branchId,
      after: { pharmacyName: data.pharmacyName, tillCode: data.tillCode },
    });
  });

  return { session, recoveryCode };
}

/** The pharmacy's name, for the login screen (before anyone has logged in). */
export async function getStoreName(ctx: ServiceContext): Promise<string> {
  const device = await loadDevice(ctx);
  if (!device) return '';
  const branch = await ctx.db
    .selectFrom('branch')
    .select('name')
    .where('id', '=', device.branchId)
    .executeTakeFirst();
  return branch?.name ?? '';
}

export interface StoreInfo {
  branchName: string;
  branchAddress: string | null;
  branchPhone: string | null;
  tillCode: string;
  userName: string;
  userRole: UserRole;
}

export async function getStoreInfo(ctx: AppContext): Promise<StoreInfo> {
  const { branchId, deviceId, userId } = ctx.session;
  const branch = await ctx.db
    .selectFrom('branch')
    .select(['name', 'address', 'phone'])
    .where('id', '=', branchId)
    .executeTakeFirst();
  const device = await ctx.db
    .selectFrom('device')
    .select('code')
    .where('id', '=', deviceId)
    .executeTakeFirst();
  const user = await ctx.db
    .selectFrom('app_user')
    .select(['name', 'role'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!branch || !device || !user) {
    throw new AppError('NOT_SET_UP', 'Store details are missing; run setup again');
  }
  return {
    branchName: branch.name,
    branchAddress: branch.address,
    branchPhone: branch.phone,
    tillCode: device.code,
    userName: user.name,
    userRole: user.role,
  };
}

export interface TaxClass {
  id: string;
  name: string;
  rateBp: number;
}

export async function listTaxClasses(ctx: ServiceContext): Promise<TaxClass[]> {
  const rows = await ctx.db
    .selectFrom('tax_class')
    .select(['id', 'name', 'rate_bp'])
    .where('is_active', '=', 1)
    .orderBy('rate_bp')
    .orderBy('name')
    .execute();
  return rows.map((row) => ({ id: row.id, name: row.name, rateBp: row.rate_bp }));
}

/** Finds a tax class by name (case-insensitive), for imports. */
export async function findTaxClassByName(
  ctx: ServiceContext,
  name: string,
): Promise<TaxClass | null> {
  const key = nameKey(name);
  return (await listTaxClasses(ctx)).find((t) => nameKey(t.name) === key) ?? null;
}
