import { AppError, nameKey } from '@app/core';
import { z } from 'zod';
import {
  timestamp,
  withSession,
  type AppContext,
  type ServiceContext,
  type Session,
} from '../context';
import { audit, insertRow } from '../writes';
import { optionalText, parseInput, requiredText } from '../validation';

const META_KEYS = {
  branchId: 'branch_id',
  deviceId: 'device_id',
  ownerUserId: 'owner_user_id',
} as const;

export const setupInputSchema = z.object({
  pharmacyName: requiredText(120, 'Enter the pharmacy name'),
  address: optionalText(200),
  phone: optionalText(40),
  tillCode: requiredText(10, 'Enter a short code for this till, e.g. T1').transform((v) =>
    v.toUpperCase(),
  ),
  ownerName: requiredText(80, 'Enter the owner’s name'),
});

export type SetupInput = z.input<typeof setupInputSchema>;

/** The session saved on this till, or null if setup hasn't run yet. */
export async function loadSession(ctx: ServiceContext): Promise<Session | null> {
  const rows = await ctx.db.selectFrom('local_meta').selectAll().execute();
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  const branchId = meta.get(META_KEYS.branchId);
  const deviceId = meta.get(META_KEYS.deviceId);
  const userId = meta.get(META_KEYS.ownerUserId);
  if (!branchId || !deviceId || !userId) return null;
  // Until PIN login arrives (M2) the owner is the acting user.
  return { branchId, deviceId, userId };
}

/** First run: creates the store, this till and the owner account. */
export async function setupStore(ctx: ServiceContext, input: SetupInput): Promise<Session> {
  const data = parseInput(setupInputSchema, input);
  if (await loadSession(ctx)) throw new AppError('INVALID_STATE', 'This till is already set up');

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
      pin_hash: null,
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
        { key: META_KEYS.branchId, value: session.branchId },
        { key: META_KEYS.deviceId, value: session.deviceId },
        { key: META_KEYS.ownerUserId, value: session.userId },
      ])
      .execute();
    await audit(trx, app, {
      action: 'store.setup',
      entityType: 'branch',
      entityId: session.branchId,
      after: { pharmacyName: data.pharmacyName, tillCode: data.tillCode },
    });
  });

  return session;
}

export interface StoreInfo {
  branchName: string;
  branchAddress: string | null;
  tillCode: string;
  userName: string;
}

export async function getStoreInfo(ctx: AppContext): Promise<StoreInfo> {
  const { branchId, deviceId, userId } = ctx.session;
  const branch = await ctx.db
    .selectFrom('branch')
    .select(['name', 'address'])
    .where('id', '=', branchId)
    .executeTakeFirst();
  const device = await ctx.db
    .selectFrom('device')
    .select('code')
    .where('id', '=', deviceId)
    .executeTakeFirst();
  const user = await ctx.db
    .selectFrom('app_user')
    .select('name')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!branch || !device || !user) {
    throw new AppError('NOT_SET_UP', 'Store details are missing; run setup again');
  }
  return {
    branchName: branch.name,
    branchAddress: branch.address,
    tillCode: device.code,
    userName: user.name,
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
