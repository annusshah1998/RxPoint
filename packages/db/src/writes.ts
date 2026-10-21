import type { Insertable, Kysely, Updateable } from 'kysely';
import type { AppContext } from './context';
import type { DB } from './schema';

/**
 * Tables that sync to the cloud (M6).
 *   mutable: rows can be updated; the newest change wins.
 *   append:  rows are never changed after insert, so they never conflict.
 * Synced rows are never deleted. Deactivate them (is_active = 0) instead.
 */
export const SYNCED_TABLES = {
  branch: 'mutable',
  device: 'mutable',
  app_user: 'mutable',
  tax_class: 'mutable',
  manufacturer: 'mutable',
  generic: 'mutable',
  product: 'mutable',
  product_unit: 'mutable',
  product_barcode: 'mutable',
  product_ingredient: 'mutable',
  batch: 'mutable',
  stock_movement: 'append',
  audit_log: 'append',
  // Milestone 2
  setting: 'mutable',
  shift: 'mutable',
  cash_movement: 'append',
  sale: 'append',
  sale_line: 'append',
  sale_line_batch: 'append',
  sale_prescription: 'append',
  sale_void: 'append',
  sale_return: 'append',
  sale_return_line: 'append',
  payment: 'append',
} as const satisfies Partial<Record<keyof DB, 'mutable' | 'append'>>;

export type SyncedTable = keyof typeof SYNCED_TABLES;
export type MutableTable = {
  [T in SyncedTable]: (typeof SYNCED_TABLES)[T] extends 'mutable' ? T : never;
}[SyncedTable];

/** Inside a transaction. */
export type Tx = Kysely<DB>;

/** Inserts a row into a synced table and queues it for upload, in the caller's transaction. */
export async function insertRow<T extends SyncedTable>(
  trx: Tx,
  now: string,
  table: T,
  row: Insertable<DB[T]> & { id: string },
): Promise<void> {
  // Kysely can't narrow a generic table name; the row type is checked by the signature.
  await trx
    .insertInto(table)
    .values(row as never)
    .execute();
  await trx
    .insertInto('sync_outbox')
    .values({
      table_name: table,
      row_id: row.id,
      op: 'insert',
      payload: JSON.stringify(row),
      created_at: now,
      sent_at: null,
    })
    .execute();
}

/**
 * Updates a row in a synced table (setting updated_at) and queues the full new row
 * for upload. Does nothing and returns false if no field actually changed.
 */
export async function updateRow<T extends MutableTable>(
  trx: Tx,
  now: string,
  table: T,
  id: string,
  patch: Updateable<DB[T]>,
): Promise<boolean> {
  // Generic table names defeat Kysely's column typing, so use a loosely typed handle here.
  // The signature above is what keeps callers type-safe.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = trx as Kysely<any>;
  const name: string = table;
  const values = patch as Record<string, unknown>;
  const before = await db.selectFrom(name).selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`${name} ${id} not found`);
  const changed = Object.entries(values).some(
    ([key, value]) => value !== undefined && before[key] !== value,
  );
  if (!changed) return false;

  await db
    .updateTable(name)
    .set({ ...values, updated_at: now })
    .where('id', '=', id)
    .execute();
  const after = await db
    .selectFrom(name)
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('sync_outbox')
    .values({
      table_name: table,
      row_id: id,
      op: 'update',
      payload: JSON.stringify(after),
      created_at: now,
      sent_at: null,
    })
    .execute();
  return true;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** The user who approved it by PIN, if someone else had to. */
  approvedBy?: string | null;
}

/** Records a sensitive change (price, stock, void, discount) in the same transaction. */
export async function audit(trx: Tx, ctx: AppContext, entry: AuditEntry): Promise<void> {
  await insertRow(trx, ctx.now().toISOString(), 'audit_log', {
    id: ctx.newId(),
    branch_id: ctx.session.branchId,
    device_id: ctx.session.deviceId,
    user_id: ctx.session.userId,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    before_json: entry.before === undefined ? null : JSON.stringify(entry.before),
    after_json: entry.after === undefined ? null : JSON.stringify(entry.after),
    reason: entry.reason ?? null,
    approved_by: entry.approvedBy ?? null,
    created_at: ctx.now().toISOString(),
  });
}
