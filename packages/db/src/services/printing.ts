import type { AppContext } from '../context';
import type { Db } from '../executor';
import { META, getMeta, setMeta } from '../meta';
import { audit, type Tx } from '../writes';
import { authorizeTx } from './guards';

/**
 * The last receipt this till meant to print. A sale, void or return writes it as
 * `pending` in its own transaction when printing is on with auto-print, so a power cut
 * straight after the commit still leaves a trace. The till marks it `done` or `failed`
 * once the printer answers, and `skipped` when staff decide not to print it.
 */
export interface LastReceipt {
  docType: ReceiptDocType;
  docId: string;
  status: ReceiptStatus;
}

export type ReceiptDocType = 'sale' | 'void' | 'return';
export type ReceiptStatus = 'pending' | 'done' | 'failed' | 'skipped';

const DOC_TYPES: readonly string[] = ['sale', 'void', 'return'] satisfies ReceiptDocType[];
const STATUSES: readonly string[] = [
  'pending',
  'done',
  'failed',
  'skipped',
] satisfies ReceiptStatus[];

function parseLastReceipt(raw: string | null): LastReceipt | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LastReceipt>;
    if (
      typeof value.docId === 'string' &&
      DOC_TYPES.includes(value.docType as string) &&
      STATUSES.includes(value.status as string)
    ) {
      return { docType: value.docType!, docId: value.docId, status: value.status! };
    }
  } catch {
    // fall through
  }
  return null;
}

/** The last receipt that was meant to print, and whether it did. */
export async function getLastReceipt(ctx: AppContext): Promise<LastReceipt | null> {
  return parseLastReceipt(await getMeta(ctx.db, META.lastReceipt));
}

/** A receipt that may not have printed: what it was for and the number staff know it by. */
export interface ReceiptNotice extends LastReceipt {
  /** The invoice (sale, void) or return number, e.g. T1-000123 or T1-R000012. */
  number: string;
  /** The sale the receipt belongs to (for a void, the voided sale). */
  saleId: string;
}

async function resolveTx(db: Db | Tx, last: LastReceipt): Promise<ReceiptNotice | null> {
  if (last.docType === 'sale') {
    const sale = await db
      .selectFrom('sale')
      .select(['id', 'invoice_no'])
      .where('id', '=', last.docId)
      .executeTakeFirst();
    return sale ? { ...last, number: sale.invoice_no, saleId: sale.id } : null;
  }
  if (last.docType === 'void') {
    const row = await db
      .selectFrom('sale_void as v')
      .innerJoin('sale as s', 's.id', 'v.sale_id')
      .select(['s.id', 's.invoice_no'])
      .where('v.id', '=', last.docId)
      .executeTakeFirst();
    return row ? { ...last, number: row.invoice_no, saleId: row.id } : null;
  }
  const ret = await db
    .selectFrom('sale_return')
    .select(['sale_id', 'return_no'])
    .where('id', '=', last.docId)
    .executeTakeFirst();
  return ret ? { ...last, number: ret.return_no, saleId: ret.sale_id } : null;
}

/**
 * The receipt to ask about after a restart: "Receipt for T1-000123 may not have printed".
 * Null when the last receipt printed, was skipped, or there is none.
 */
export async function getReceiptNotice(ctx: AppContext): Promise<ReceiptNotice | null> {
  const last = await getLastReceipt(ctx);
  if (!last || (last.status !== 'pending' && last.status !== 'failed')) return null;
  return resolveTx(ctx.db, last);
}

/**
 * Records how printing a receipt went. Only the receipt still on record is changed: a
 * slow answer about an older receipt never hides a newer one that may not have printed.
 */
export async function setReceiptStatus(
  ctx: AppContext,
  receipt: { docType: ReceiptDocType; docId: string },
  status: Exclude<ReceiptStatus, 'pending'>,
): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    const last = parseLastReceipt(await getMeta(trx, META.lastReceipt));
    if (!last || last.docType !== receipt.docType || last.docId !== receipt.docId) return;
    await setMeta(trx, META.lastReceipt, JSON.stringify({ ...last, status }));
  });
}

/**
 * Logs opening the cash drawer from Settings to test it. Settings can be changed without
 * an open shift, so this isn't a no-sale; it is still on record.
 */
export async function recordDrawerTest(ctx: AppContext, input: { pin: 2 | 5 }): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'settings.edit');
    await audit(trx, ctx, {
      action: 'drawer.test',
      entityType: 'device',
      entityId: ctx.session.deviceId,
      after: { pin: input.pin },
    });
  });
}
