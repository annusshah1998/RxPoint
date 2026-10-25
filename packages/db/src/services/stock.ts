import { INVENTORY } from '@app/config';
import {
  AppError,
  addDays,
  allocateFefo,
  daysBetween,
  expiryStatus,
  isIsoDate,
  nameKey,
  priceForQty,
  type ExpiryStatus,
  type FefoResult,
  type IsoDate,
  type Money,
  type UnitDef,
} from '@app/core';
import { sql } from 'kysely';
import { z } from 'zod';
import { timestamp, type AppContext } from '../context';
import type { Db } from '../executor';
import type { BatchSource } from '../schema';
import { optionalText, parseInput, requiredText } from '../validation';
import { audit, insertRow, type Tx } from '../writes';
import { requireProduct } from './catalog';
import { authorizeTx, expiryTodayTx } from './guards';

const moneyOrNull = z
  .number()
  .int()
  .min(0, 'Cannot be negative')
  .nullish()
  .transform((v) => v ?? null);

const expirySchema = z
  .string()
  .nullish()
  .transform((v) => v || null)
  .refine((v) => v === null || isIsoDate(v), 'Enter a valid expiry date');

export const openingStockSchema = z.object({
  productId: z.string().min(1),
  batchNo: optionalText(40).transform((v) => v ?? ''),
  expiryDate: expirySchema,
  /** Base units. */
  qty: z
    .number('Enter a quantity')
    .int('Use a whole number')
    .min(1, 'Enter a quantity')
    .max(10_000_000),
  /** For `packQty` base units; defaults to the product's price unit. */
  costPrice: moneyOrNull,
  mrp: moneyOrNull,
  packQty: z.number().int().min(1).optional(),
});

export type OpeningStockInput = z.input<typeof openingStockSchema>;

export interface StockWriteResult {
  batchId: string;
  movementId: string;
  warnings: string[];
}

async function insertMovement(
  trx: Tx,
  ctx: AppContext,
  movement: {
    productId: string;
    batchId: string;
    qty: number;
    kind: 'opening' | 'adjustment';
    reason?: string | null;
  },
): Promise<string> {
  const id = ctx.newId();
  const now = timestamp(ctx);
  await insertRow(trx, now, 'stock_movement', {
    id,
    branch_id: ctx.session.branchId,
    device_id: ctx.session.deviceId,
    product_id: movement.productId,
    batch_id: movement.batchId,
    qty: movement.qty,
    kind: movement.kind,
    ref_type: null,
    ref_id: null,
    reason: movement.reason ?? null,
    user_id: ctx.session.userId,
    created_at: now,
  });
  return id;
}

/**
 * Records stock that was already on the shelf when the till started being used.
 * Entering the same batch twice adds to it instead of creating a second batch.
 */
export async function addOpeningStock(
  ctx: AppContext,
  input: OpeningStockInput,
): Promise<StockWriteResult> {
  const data = parseInput(openingStockSchema, input);
  const product = await requireProduct(ctx, data.productId);
  const packQty = data.packQty ?? product.priceQty;
  const date = await expiryTodayTx(ctx.db, ctx);

  const warnings: string[] = [];
  if (!data.batchNo) warnings.push('No batch number entered');
  if (!data.expiryDate) warnings.push('No expiry date entered');
  else if (data.expiryDate < date) warnings.push('This batch has already expired');
  if (
    data.mrp !== null &&
    priceForQty({ amount: product.salePrice, perQty: product.priceQty }, packQty) > data.mrp
  ) {
    warnings.push('The sale price is higher than this batch’s MRP');
  }

  return ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'stock.adjust');
    const ids = await insertOpeningStockTx(trx, ctx, { ...data, productId: product.id, packQty });
    return { ...ids, warnings };
  });
}

export interface OpeningStockLine {
  productId: string;
  batchNo: string;
  expiryDate: IsoDate | null;
  qty: number;
  packQty: number;
  costPrice: Money | null;
  mrp: Money | null;
}

/** The write behind addOpeningStock, for callers that manage their own transaction. */
export async function insertOpeningStockTx(
  trx: Tx,
  ctx: AppContext,
  line: OpeningStockLine,
): Promise<{ batchId: string; movementId: string }> {
  const now = timestamp(ctx);
  const existing = await trx
    .selectFrom('batch')
    .select('id')
    .where('product_id', '=', line.productId)
    .where('source', '=', 'opening')
    .where(sql<boolean>`lower(batch_no) = ${nameKey(line.batchNo)}`)
    .where(sql<boolean>`expiry_date IS ${line.expiryDate}`)
    .where('pack_qty', '=', line.packQty)
    .where(sql<boolean>`cost_price IS ${line.costPrice}`)
    .where(sql<boolean>`mrp IS ${line.mrp}`)
    .executeTakeFirst();

  let batchId = existing?.id;
  if (!batchId) {
    batchId = ctx.newId();
    await insertRow(trx, now, 'batch', {
      id: batchId,
      product_id: line.productId,
      batch_no: line.batchNo,
      expiry_date: line.expiryDate,
      pack_qty: line.packQty,
      cost_price: line.costPrice,
      mrp: line.mrp,
      source: 'opening',
      is_placeholder: 0,
      created_at: now,
      updated_at: now,
    });
  }
  const movementId = await insertMovement(trx, ctx, {
    productId: line.productId,
    batchId,
    qty: line.qty,
    kind: 'opening',
  });
  await audit(trx, ctx, {
    action: 'stock.opening',
    entityType: 'batch',
    entityId: batchId,
    after: { qty: line.qty, batchNo: line.batchNo, expiryDate: line.expiryDate },
  });
  return { batchId, movementId };
}

export const adjustStockSchema = z.object({
  batchId: z.string().min(1),
  /** Signed base units. */
  qtyDelta: z
    .number('Enter a quantity')
    .int('Use a whole number')
    .refine((v) => v !== 0, 'Enter a quantity other than zero'),
  reason: requiredText(200, 'Say why the stock is being changed'),
});

export type AdjustStockInput = z.input<typeof adjustStockSchema>;

/** Corrects the quantity of a batch, with a reason. Recorded in the audit log. */
export async function adjustStock(
  ctx: AppContext,
  input: AdjustStockInput,
): Promise<StockWriteResult> {
  const data = parseInput(adjustStockSchema, input);
  return ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'stock.adjust');
    const batch = await trx
      .selectFrom('batch')
      .select(['id', 'product_id'])
      .where('id', '=', data.batchId)
      .executeTakeFirst();
    if (!batch) throw new AppError('NOT_FOUND', 'Batch not found');
    const onHand = await batchQty(trx, ctx.session.branchId, batch.id);
    if (onHand + data.qtyDelta < 0) {
      throw new AppError('VALIDATION', `Only ${onHand} in this batch; cannot remove more`, {
        qtyDelta: 'More than is in stock',
      });
    }
    const movementId = await insertMovement(trx, ctx, {
      productId: batch.product_id,
      batchId: batch.id,
      qty: data.qtyDelta,
      kind: 'adjustment',
      reason: data.reason,
    });
    await audit(trx, ctx, {
      action: 'stock.adjust',
      entityType: 'batch',
      entityId: batch.id,
      before: { qty: onHand },
      after: { qty: onHand + data.qtyDelta },
      reason: data.reason,
    });
    return { batchId: batch.id, movementId, warnings: [] };
  });
}

async function batchQty(db: Db | Tx, branchId: string, batchId: string): Promise<number> {
  const row = await db
    .selectFrom('batch_stock')
    .select('qty')
    .where('branch_id', '=', branchId)
    .where('batch_id', '=', batchId)
    .executeTakeFirst();
  return row?.qty ?? 0;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface BatchStock {
  batchId: string;
  batchNo: string;
  expiryDate: IsoDate | null;
  status: ExpiryStatus;
  daysToExpiry: number | null;
  qty: number;
  packQty: number;
  costPrice: Money | null;
  mrp: Money | null;
  /** Cost of the quantity on hand; null if the batch cost is unknown. */
  value: Money | null;
  source: BatchSource;
  /** The product's "Unrecorded stock" batch: sales made beyond recorded stock. */
  isPlaceholder: boolean;
  receivedAt: string;
}

export interface ProductStock {
  totalQty: number;
  /** Excludes expired batches. */
  sellableQty: number;
  batches: BatchStock[];
}

function toBatchStock(
  row: {
    id: string;
    batch_no: string;
    expiry_date: string | null;
    qty: number;
    pack_qty: number;
    cost_price: number | null;
    mrp: number | null;
    source: BatchSource;
    is_placeholder: number;
    created_at: string;
  },
  date: IsoDate,
): BatchStock {
  return {
    batchId: row.id,
    batchNo: row.batch_no,
    expiryDate: row.expiry_date,
    status: expiryStatus(row.expiry_date, date, INVENTORY.nearExpiryDays),
    daysToExpiry: row.expiry_date ? daysBetween(date, row.expiry_date) : null,
    qty: row.qty,
    packQty: row.pack_qty,
    costPrice: row.cost_price,
    mrp: row.mrp,
    value:
      row.cost_price === null
        ? null
        : priceForQty({ amount: row.cost_price, perQty: row.pack_qty }, row.qty),
    source: row.source,
    isPlaceholder: row.is_placeholder === 1,
    receivedAt: row.created_at,
  };
}

const BATCH_COLUMNS = [
  'b.id',
  'b.batch_no',
  'b.expiry_date',
  'b.pack_qty',
  'b.cost_price',
  'b.mrp',
  'b.source',
  'b.is_placeholder',
  'b.created_at',
  's.qty',
] as const;

/** Batches of one product in this branch, soonest expiry first. */
export async function getProductStock(
  ctx: AppContext,
  productId: string,
  options: { includeEmpty?: boolean } = {},
): Promise<ProductStock> {
  let q = ctx.db
    .selectFrom('batch as b')
    .innerJoin('batch_stock as s', (join) =>
      join.onRef('s.batch_id', '=', 'b.id').on('s.branch_id', '=', ctx.session.branchId),
    )
    .select(BATCH_COLUMNS)
    .where('b.product_id', '=', productId)
    .orderBy(sql`b.expiry_date IS NULL`)
    .orderBy('b.expiry_date')
    .orderBy('b.created_at');
  if (!options.includeEmpty) q = q.where('s.qty', '!=', 0);
  const date = await expiryTodayTx(ctx.db, ctx);
  const batches = (await q.execute()).map((row) => toBatchStock(row, date));
  return {
    totalQty: batches.reduce((sum, b) => sum + b.qty, 0),
    sellableQty: batches
      .filter((b) => b.status !== 'expired')
      .reduce((sum, b) => sum + Math.max(b.qty, 0), 0),
    batches,
  };
}

/** Which recorded batches a sale of `qty` base units would take from. */
export async function planFefo(
  ctx: AppContext,
  productId: string,
  qty: number,
): Promise<FefoResult> {
  const { batches } = await getProductStock(ctx, productId);
  return allocateFefo(
    batches
      .filter((b) => !b.isPlaceholder)
      .map((b) => ({
        batchId: b.batchId,
        expiryDate: b.expiryDate,
        qty: b.qty,
        receivedAt: b.receivedAt,
      })),
    qty,
    { today: await expiryTodayTx(ctx.db, ctx) },
  );
}

export type StockFilter = 'in_stock' | 'near_expiry' | 'expired';

export interface StockListRow extends BatchStock {
  productId: string;
  productName: string;
  strength: string | null;
  units: UnitDef[];
}

/** Batches with stock, soonest expiry first, optionally only near-expiry or expired ones. */
export async function listStock(
  ctx: AppContext,
  options: { filter?: StockFilter; search?: string; limit?: number } = {},
): Promise<StockListRow[]> {
  const { filter = 'in_stock', search, limit = 500 } = options;
  const date = await expiryTodayTx(ctx.db, ctx);
  let q = ctx.db
    .selectFrom('batch_stock as s')
    .innerJoin('batch as b', 'b.id', 's.batch_id')
    .innerJoin('product as p', 'p.id', 'b.product_id')
    .select(BATCH_COLUMNS)
    .select(['p.id as product_id', 'p.name as product_name', 'p.strength'])
    .where('s.branch_id', '=', ctx.session.branchId)
    .where('s.qty', '>', 0)
    .orderBy(sql`b.expiry_date IS NULL`)
    .orderBy('b.expiry_date')
    .orderBy('p.name_key')
    .limit(limit);
  if (filter === 'expired') q = q.where('b.expiry_date', '<', date);
  if (filter === 'near_expiry') {
    q = q
      .where('b.expiry_date', '>=', date)
      .where('b.expiry_date', '<=', addDays(date, INVENTORY.nearExpiryDays));
  }
  if (search?.trim()) {
    const pattern = `%${search.trim().toLowerCase()}%`;
    q = q.where((eb) =>
      eb.or([eb('p.name_key', 'like', pattern), eb(sql`lower(b.batch_no)`, 'like', pattern)]),
    );
  }
  const rows = await q.execute();
  const units = await loadUnits(
    ctx,
    rows.map((r) => r.product_id),
  );
  return rows.map((row) => ({
    ...toBatchStock(row, date),
    productId: row.product_id,
    productName: row.product_name,
    strength: row.strength,
    units: units.get(row.product_id) ?? [{ name: 'Unit', qty: 1 }],
  }));
}

async function loadUnits(ctx: AppContext, productIds: string[]): Promise<Map<string, UnitDef[]>> {
  const map = new Map<string, UnitDef[]>();
  const unique = [...new Set(productIds)];
  // Stay well under SQLite's bound-parameter limit.
  for (let i = 0; i < unique.length; i += 500) {
    const rows = await ctx.db
      .selectFrom('product_unit')
      .select(['product_id', 'name', 'qty'])
      .where('product_id', 'in', unique.slice(i, i + 500))
      .where('is_active', '=', 1)
      .execute();
    for (const row of rows) {
      const list = map.get(row.product_id) ?? [];
      list.push({ name: row.name, qty: row.qty });
      map.set(row.product_id, list);
    }
  }
  return map;
}

export interface StockSummary {
  /** Cost of all stock on hand (batches with a known cost). */
  stockValue: Money;
  expiredValue: Money;
  nearExpiryValue: Money;
  expiredBatches: number;
  nearExpiryBatches: number;
  /** Batches on hand with no cost recorded, so not counted in the values. */
  batchesWithoutCost: number;
  productsInStock: number;
}

export async function getStockSummary(ctx: AppContext): Promise<StockSummary> {
  const date = await expiryTodayTx(ctx.db, ctx);
  const rows = await ctx.db
    .selectFrom('batch_stock as s')
    .innerJoin('batch as b', 'b.id', 's.batch_id')
    .select(BATCH_COLUMNS)
    .select('b.product_id')
    .where('s.branch_id', '=', ctx.session.branchId)
    .where('s.qty', '>', 0)
    .execute();
  const summary: StockSummary = {
    stockValue: 0,
    expiredValue: 0,
    nearExpiryValue: 0,
    expiredBatches: 0,
    nearExpiryBatches: 0,
    batchesWithoutCost: 0,
    productsInStock: new Set(rows.map((r) => r.product_id)).size,
  };
  for (const row of rows) {
    const batch = toBatchStock(row, date);
    if (batch.status === 'expired') summary.expiredBatches++;
    if (batch.status === 'near') summary.nearExpiryBatches++;
    if (batch.value === null) {
      summary.batchesWithoutCost++;
      continue;
    }
    summary.stockValue += batch.value;
    if (batch.status === 'expired') summary.expiredValue += batch.value;
    if (batch.status === 'near') summary.nearExpiryValue += batch.value;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Ledger integrity
// ---------------------------------------------------------------------------

/** Recomputes batch_stock from the movement ledger. */
export async function rebuildStockCache(db: Db): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`DELETE FROM batch_stock`.execute(trx);
    await sql`
      INSERT INTO batch_stock (branch_id, batch_id, product_id, qty)
      SELECT branch_id, batch_id, product_id, SUM(qty)
      FROM stock_movement
      GROUP BY branch_id, batch_id, product_id
    `.execute(trx);
  });
}

/** Batches whose cached stock doesn't match the ledger. Should always be empty. */
export async function findStockCacheMismatches(
  db: Db,
): Promise<{ branchId: string; batchId: string; cached: number; ledger: number }[]> {
  const result = await sql<{ branch_id: string; batch_id: string; cached: number; ledger: number }>`
    WITH ledger AS (
      SELECT branch_id, batch_id, SUM(qty) AS qty FROM stock_movement GROUP BY branch_id, batch_id
    )
    SELECT COALESCE(l.branch_id, s.branch_id) AS branch_id,
           COALESCE(l.batch_id, s.batch_id) AS batch_id,
           COALESCE(s.qty, 0) AS cached,
           COALESCE(l.qty, 0) AS ledger
    FROM ledger l FULL OUTER JOIN batch_stock s
      ON s.branch_id = l.branch_id AND s.batch_id = l.batch_id
    WHERE COALESCE(s.qty, 0) != COALESCE(l.qty, 0)
  `.execute(db);
  return result.rows.map((r) => ({
    branchId: r.branch_id,
    batchId: r.batch_id,
    cached: r.cached,
    ledger: r.ledger,
  }));
}
