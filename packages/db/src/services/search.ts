import { cleanText, type Money, type ProductForm, type UnitDef } from '@app/core';
import { sql } from 'kysely';
import type { AppContext } from '../context';
import type { Db } from '../executor';
import type { Tx } from '../writes';

// The search index row for products: brand, salts, strengths and maker as text.
// Ordered aggregates (group_concat ... ORDER BY) need SQLite 3.44+.
const INDEX_ROWS = `
  SELECT
    p.id AS product_id,
    p.name AS name,
    COALESCE((
      SELECT group_concat(g.name, ' + ' ORDER BY pi.sort_order)
      FROM product_ingredient pi JOIN generic g ON g.id = pi.generic_id
      WHERE pi.product_id = p.id AND pi.is_active = 1
    ), '') AS generics,
    TRIM(COALESCE(p.strength, '') || ' ' || COALESCE((
      SELECT group_concat(pi.strength, ' ' ORDER BY pi.sort_order)
      FROM product_ingredient pi
      WHERE pi.product_id = p.id AND pi.is_active = 1 AND pi.strength IS NOT NULL
    ), '')) AS strength,
    p.form AS form,
    COALESCE(m.name, '') AS manufacturer
  FROM product p LEFT JOIN manufacturer m ON m.id = p.manufacturer_id`;

const INSERT_INDEX = `INSERT INTO product_fts (product_id, name, generics, strength, form, manufacturer)`;

/** Refreshes one product's search entry. Call inside the transaction that changed it. */
export async function reindexProduct(trx: Tx, productId: string): Promise<void> {
  await sql`DELETE FROM product_fts WHERE product_id = ${productId}`.execute(trx);
  await sql`${sql.raw(INSERT_INDEX)} ${sql.raw(INDEX_ROWS)} WHERE p.id = ${productId}`.execute(trx);
}

/** Rebuilds the whole search index, e.g. after a bulk import. */
export async function rebuildSearchIndex(db: Db | Tx): Promise<void> {
  await sql`DELETE FROM product_fts`.execute(db);
  await sql`${sql.raw(INSERT_INDEX)} ${sql.raw(INDEX_ROWS)}`.execute(db);
}

export interface ProductHit {
  id: string;
  name: string;
  strength: string | null;
  form: ProductForm;
  generics: string;
  manufacturer: string | null;
  salePrice: Money;
  priceQty: number;
  rack: string | null;
  rxRequired: boolean;
  controlledSchedule: string | null;
  isActive: boolean;
  /** Stock on hand in this branch, in base units. */
  stockQty: number;
  units: (UnitDef & { id: string })[];
  /** Set when the hit came from an exact barcode scan. */
  scannedUnitId?: string;
}

export interface SearchOptions {
  limit?: number;
  includeInactive?: boolean;
}

const MIN_TRIGRAM = 3;

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Finds products by brand, generic/salt, strength or manufacturer, or by exact barcode.
 * Words of 3+ characters use the trigram index (matching anywhere in the text);
 * shorter words fall back to a substring match. All words must match.
 * Exact and starts-with matches on the brand name come first.
 */
export async function searchProducts(
  ctx: AppContext,
  query: string,
  options: SearchOptions = {},
): Promise<ProductHit[]> {
  const { limit = 50, includeInactive = false } = options;
  const text = cleanText(query);

  if (text) {
    const scanned = await findProductByBarcode(ctx, text);
    if (scanned) {
      const hits = await loadHits(ctx, [scanned.productId]);
      return hits.map((hit) => ({ ...hit, scannedUnitId: scanned.unitId }));
    }
  }

  const words = text.toLowerCase().split(' ').filter(Boolean);
  const long = words.filter((w) => w.length >= MIN_TRIGRAM);
  const short = words.filter((w) => w.length < MIN_TRIGRAM);
  const lowered = text.toLowerCase();

  let q = ctx.db
    .selectFrom('product_fts as f')
    .innerJoin('product as p', 'p.id', 'f.product_id')
    .select('p.id')
    .limit(limit);

  if (long.length > 0) {
    // Each word becomes a quoted phrase; FTS5 ANDs them.
    const match = long.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
    q = q.where(sql<boolean>`f.product_fts MATCH ${match}`);
  }
  for (const word of short) {
    const pattern = `%${escapeLike(word)}%`;
    q = q.where(
      sql<boolean>`(f.name || ' ' || f.generics || ' ' || f.strength || ' ' || f.form || ' ' || f.manufacturer) LIKE ${pattern} ESCAPE '\\'`,
    );
  }
  if (!includeInactive) q = q.where('p.is_active', '=', 1);

  if (text) {
    q = q
      .orderBy(sql`p.name_key = ${lowered}`, 'desc')
      .orderBy(sql`p.name_key LIKE ${`${escapeLike(lowered)}%`} ESCAPE '\\'`, 'desc');
    if (long.length > 0) q = q.orderBy(sql`f.rank`);
  }
  q = q.orderBy('p.name_key').orderBy('p.strength');

  const ids = (await q.execute()).map((row) => row.id);
  return loadHits(ctx, ids);
}

export async function findProductByBarcode(
  ctx: AppContext,
  barcode: string,
): Promise<{ productId: string; unitId: string } | null> {
  const row = await ctx.db
    .selectFrom('product_barcode')
    .select(['product_id', 'unit_id'])
    .where('barcode', '=', barcode.trim())
    .where('is_active', '=', 1)
    .executeTakeFirst();
  return row ? { productId: row.product_id, unitId: row.unit_id } : null;
}

/** Loads display data for products, keeping the order of `ids`. */
async function loadHits(ctx: AppContext, ids: string[]): Promise<ProductHit[]> {
  if (ids.length === 0) return [];
  const rows = await ctx.db
    .selectFrom('product as p')
    .innerJoin('product_fts as f', 'f.product_id', 'p.id')
    .leftJoin('manufacturer as m', 'm.id', 'p.manufacturer_id')
    .select([
      'p.id',
      'p.name',
      'p.strength',
      'p.form',
      'f.generics',
      'm.name as manufacturer',
      'p.sale_price',
      'p.price_qty',
      'p.rack',
      'p.rx_required',
      'p.controlled_schedule',
      'p.is_active',
    ])
    .select((eb) =>
      eb
        .selectFrom('batch_stock as s')
        .select(sql<number>`COALESCE(SUM(s.qty), 0)`.as('qty'))
        .whereRef('s.product_id', '=', 'p.id')
        .where('s.branch_id', '=', ctx.session.branchId)
        .as('stock_qty'),
    )
    .where('p.id', 'in', ids)
    .execute();
  const units = await ctx.db
    .selectFrom('product_unit')
    .select(['id', 'product_id', 'name', 'qty'])
    .where('product_id', 'in', ids)
    .where('is_active', '=', 1)
    .orderBy('qty')
    .execute();

  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        id: row.id,
        name: row.name,
        strength: row.strength,
        form: row.form as ProductForm,
        generics: row.generics,
        manufacturer: row.manufacturer,
        salePrice: row.sale_price,
        priceQty: row.price_qty,
        rack: row.rack,
        rxRequired: row.rx_required === 1,
        controlledSchedule: row.controlled_schedule,
        isActive: row.is_active === 1,
        stockQty: Number(row.stock_qty ?? 0),
        units: units
          .filter((u) => u.product_id === id)
          .map((u) => ({ id: u.id, name: u.name, qty: u.qty })),
      },
    ];
  });
}
