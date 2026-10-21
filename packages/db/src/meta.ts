import type { Db } from './executor';
import type { Tx } from './writes';

/** Keys in local_meta: facts about this installation that never sync. */
export const META = {
  branchId: 'branch_id',
  deviceId: 'device_id',
  /** The owner created at setup (the one the recovery code belongs to). */
  ownerUserId: 'owner_user_id',
  /** Hash of the owner's one-time recovery code. */
  recoveryHash: 'recovery_hash',
  /** The latest time any document was written; the clock should never be far behind it. */
  clockHighWater: 'clock_high_water',
  /** Set when someone approved selling with a clock that looks wrong. */
  clockOverride: 'clock_override',
  /** Lowest number the next invoice / return may take (raised after a restore). */
  invoiceFloor: 'invoice_floor',
  returnFloor: 'return_floor',
  /** Printer, drawer and backup folder for this till (JSON). */
  deviceSettings: 'device_settings',
} as const;

export type MetaKey = (typeof META)[keyof typeof META];

export async function getMeta(db: Db | Tx, key: MetaKey): Promise<string | null> {
  const row = await db
    .selectFrom('local_meta')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst();
  return row?.value ?? null;
}

export async function setMeta(db: Db | Tx, key: MetaKey, value: string): Promise<void> {
  await db
    .insertInto('local_meta')
    .values({ key, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute();
}

export async function deleteMeta(db: Db | Tx, key: MetaKey): Promise<void> {
  await db.deleteFrom('local_meta').where('key', '=', key).execute();
}
