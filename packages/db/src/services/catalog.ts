import { AppError, PRODUCT_FORMS, nameKey, type Money, type ProductForm } from '@app/core';
import { sql } from 'kysely';
import { z } from 'zod';
import { timestamp, type AppContext, type ServiceContext } from '../context';
import type { Bool } from '../schema';
import { optionalText, parseInput, requiredText } from '../validation';
import { audit, insertRow, updateRow, type Tx } from '../writes';
import { authorizeTx } from './guards';
import { reindexProduct } from './search';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const unitSchema = z.object({
  id: z.string().optional(),
  name: requiredText(30, 'Enter the unit name'),
  qty: z
    .number('Enter how many base units it holds')
    .int('Use a whole number')
    .min(1, 'Must be at least 1')
    .max(100_000, 'That is too many'),
  isSellable: z.boolean(),
  barcodes: z.array(z.string().trim().min(1).max(64, 'Barcode is too long')).max(10).default([]),
});

const ingredientSchema = z.object({
  generic: requiredText(120, 'Enter the generic (salt) name'),
  strength: optionalText(60),
});

export const productInputSchema = z
  .object({
    name: requiredText(120, 'Enter the product name'),
    strength: optionalText(60),
    form: z.enum(PRODUCT_FORMS, 'Choose a form'),
    manufacturer: optionalText(120),
    ingredients: z.array(ingredientSchema).max(10).default([]),
    units: z.array(unitSchema).min(1, 'Add at least one unit').max(6, 'Use at most 6 units'),
    salePrice: z.number('Enter the sale price').int().min(0, 'Price cannot be negative'),
    priceQty: z.number('Choose which unit the price is for').int().min(1),
    costPrice: z
      .number()
      .int()
      .min(0, 'Cost cannot be negative')
      .nullish()
      .transform((v) => v ?? null),
    taxClassId: z
      .string()
      .nullish()
      .transform((v) => v || null),
    rxRequired: z.boolean().default(false),
    allowDiscount: z.boolean().default(true),
    controlledSchedule: optionalText(10).transform((v) => v?.toUpperCase() ?? null),
    rack: optionalText(30),
    reorderLevel: z
      .number()
      .int()
      .min(0, 'Cannot be negative')
      .nullish()
      .transform((v) => v ?? null),
    notes: optionalText(500),
  })
  .superRefine((p, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });

    const baseUnits = p.units.filter((u) => u.qty === 1);
    if (baseUnits.length !== 1) {
      issue(['units'], 'Exactly one unit must hold 1 (the smallest unit, e.g. Tablet)');
    }
    if (!p.units.some((u) => u.isSellable)) {
      issue(['units'], 'At least one unit must be sellable');
    }
    const names = new Set<string>();
    const qtys = new Set<number>();
    const barcodes = new Set<string>();
    p.units.forEach((unit, i) => {
      const key = nameKey(unit.name);
      if (names.has(key)) issue(['units', i, 'name'], 'Two units have the same name');
      names.add(key);
      if (qtys.has(unit.qty)) issue(['units', i, 'qty'], 'Two units hold the same quantity');
      qtys.add(unit.qty);
      for (const code of unit.barcodes) {
        if (barcodes.has(code)) issue(['units', i, 'barcodes'], `Barcode ${code} is listed twice`);
        barcodes.add(code);
      }
    });
    if (!qtys.has(p.priceQty)) issue(['priceQty'], 'Choose which unit the price is for');

    const generics = new Set<string>();
    p.ingredients.forEach((ing, i) => {
      const key = nameKey(ing.generic);
      if (generics.has(key)) issue(['ingredients', i, 'generic'], 'Listed twice');
      generics.add(key);
    });
  })
  // Controlled drugs always need a prescription.
  .transform((p) => ({ ...p, rxRequired: p.rxRequired || p.controlledSchedule !== null }));

export type ProductInput = z.input<typeof productInputSchema>;
export type ParsedProduct = z.output<typeof productInputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface ProductUnit {
  id: string;
  name: string;
  qty: number;
  isSellable: boolean;
  barcodes: string[];
}

export interface ProductIngredient {
  genericId: string;
  generic: string;
  strength: string | null;
}

export interface ProductDetail {
  id: string;
  name: string;
  strength: string | null;
  form: ProductForm;
  manufacturer: string | null;
  ingredients: ProductIngredient[];
  /** Smallest first; the first is the base unit. */
  units: ProductUnit[];
  salePrice: Money;
  priceQty: number;
  costPrice: Money | null;
  taxClassId: string | null;
  rxRequired: boolean;
  controlledSchedule: string | null;
  rack: string | null;
  reorderLevel: number | null;
  notes: string | null;
  allowDiscount: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Turns a stored product back into form input, for editing. */
export function toProductInput(product: ProductDetail): ProductInput {
  return {
    name: product.name,
    strength: product.strength,
    form: product.form,
    manufacturer: product.manufacturer,
    ingredients: product.ingredients.map((i) => ({ generic: i.generic, strength: i.strength })),
    units: product.units.map((u) => ({
      id: u.id,
      name: u.name,
      qty: u.qty,
      isSellable: u.isSellable,
      barcodes: u.barcodes,
    })),
    salePrice: product.salePrice,
    priceQty: product.priceQty,
    costPrice: product.costPrice,
    taxClassId: product.taxClassId,
    rxRequired: product.rxRequired,
    controlledSchedule: product.controlledSchedule,
    rack: product.rack,
    reorderLevel: product.reorderLevel,
    notes: product.notes,
    allowDiscount: product.allowDiscount,
  };
}

const bool = (value: boolean): Bool => (value ? 1 : 0);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getProduct(ctx: ServiceContext, id: string): Promise<ProductDetail | null> {
  const row = await ctx.db
    .selectFrom('product')
    .leftJoin('manufacturer', 'manufacturer.id', 'product.manufacturer_id')
    .selectAll('product')
    .select('manufacturer.name as manufacturer_name')
    .where('product.id', '=', id)
    .executeTakeFirst();
  if (!row) return null;

  const units = await ctx.db
    .selectFrom('product_unit')
    .select(['id', 'name', 'qty', 'is_sellable'])
    .where('product_id', '=', id)
    .where('is_active', '=', 1)
    .orderBy('qty')
    .execute();
  const barcodes = await ctx.db
    .selectFrom('product_barcode')
    .select(['unit_id', 'barcode'])
    .where('product_id', '=', id)
    .where('is_active', '=', 1)
    .orderBy('created_at')
    .execute();
  const ingredients = await ctx.db
    .selectFrom('product_ingredient')
    .innerJoin('generic', 'generic.id', 'product_ingredient.generic_id')
    .select(['generic.id as generic_id', 'generic.name', 'product_ingredient.strength'])
    .where('product_ingredient.product_id', '=', id)
    .where('product_ingredient.is_active', '=', 1)
    .orderBy('product_ingredient.sort_order')
    .execute();

  return {
    id: row.id,
    name: row.name,
    strength: row.strength,
    form: row.form as ProductForm,
    manufacturer: row.manufacturer_name,
    ingredients: ingredients.map((i) => ({
      genericId: i.generic_id,
      generic: i.name,
      strength: i.strength,
    })),
    units: units.map((u) => ({
      id: u.id,
      name: u.name,
      qty: u.qty,
      isSellable: u.is_sellable === 1,
      barcodes: barcodes.filter((b) => b.unit_id === u.id).map((b) => b.barcode),
    })),
    salePrice: row.sale_price,
    priceQty: row.price_qty,
    costPrice: row.cost_price,
    taxClassId: row.tax_class_id,
    rxRequired: row.rx_required === 1,
    controlledSchedule: row.controlled_schedule,
    rack: row.rack,
    reorderLevel: row.reorder_level,
    notes: row.notes,
    allowDiscount: row.allow_discount === 1,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function requireProduct(ctx: ServiceContext, id: string): Promise<ProductDetail> {
  const product = await getProduct(ctx, id);
  if (!product) throw new AppError('NOT_FOUND', 'Product not found');
  return product;
}

/** Names for autocomplete in the product form. */
export async function listManufacturerNames(ctx: ServiceContext): Promise<string[]> {
  const rows = await ctx.db.selectFrom('manufacturer').select('name').orderBy('name_key').execute();
  return rows.map((r) => r.name);
}

export async function listGenericNames(ctx: ServiceContext): Promise<string[]> {
  const rows = await ctx.db.selectFrom('generic').select('name').orderBy('name_key').execute();
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Name → id caches, so bulk imports don't look the same maker up thousands of times. */
export interface LookupCache {
  manufacturers: Map<string, string>;
  generics: Map<string, string>;
}

export function newLookupCache(): LookupCache {
  return { manufacturers: new Map(), generics: new Map() };
}

async function resolveNamed(
  trx: Tx,
  ctx: AppContext,
  table: 'manufacturer' | 'generic',
  name: string,
  cache: Map<string, string>,
): Promise<string> {
  const key = nameKey(name);
  const cached = cache.get(key);
  if (cached) return cached;
  const existing = await trx
    .selectFrom(table)
    .select('id')
    .where('name_key', '=', key)
    .executeTakeFirst();
  let id = existing?.id;
  if (!id) {
    id = ctx.newId();
    const now = timestamp(ctx);
    await insertRow(trx, now, table, { id, name, name_key: key, created_at: now, updated_at: now });
  }
  cache.set(key, id);
  return id;
}

async function assertBarcodesFree(trx: Tx, data: ParsedProduct, productId: string | null) {
  const codes = data.units.flatMap((u) => u.barcodes);
  if (codes.length === 0) return;
  let query = trx
    .selectFrom('product_barcode')
    .innerJoin('product', 'product.id', 'product_barcode.product_id')
    .select(['product_barcode.barcode', 'product.name'])
    .where('product_barcode.barcode', 'in', codes)
    .where('product_barcode.is_active', '=', 1);
  if (productId) query = query.where('product_barcode.product_id', '!=', productId);
  const taken = await query.executeTakeFirst();
  if (taken) {
    const index = data.units.findIndex((u) => u.barcodes.includes(taken.barcode));
    throw new AppError(
      'BARCODE_TAKEN',
      `Barcode ${taken.barcode} already belongs to ${taken.name}`,
      { [`units.${index}.barcodes`]: `Already used by ${taken.name}` },
    );
  }
}

async function assertNotDuplicate(
  trx: Tx,
  data: ParsedProduct,
  manufacturerId: string | null,
  productId: string | null,
) {
  let query = trx
    .selectFrom('product')
    .select('id')
    .where('name_key', '=', nameKey(data.name))
    .where(sql<boolean>`strength IS ${data.strength}`)
    .where(sql<boolean>`manufacturer_id IS ${manufacturerId}`)
    .where('form', '=', data.form)
    .where('is_active', '=', 1);
  if (productId) query = query.where('id', '!=', productId);
  if (await query.executeTakeFirst()) {
    throw new AppError(
      'DUPLICATE',
      'A product with this name, strength, form and manufacturer already exists',
      { name: 'Already in the catalog' },
    );
  }
}

async function assertTaxClass(trx: Tx, taxClassId: string | null) {
  if (!taxClassId) return;
  const found = await trx
    .selectFrom('tax_class')
    .select('id')
    .where('id', '=', taxClassId)
    .executeTakeFirst();
  if (!found) {
    throw new AppError('VALIDATION', 'Choose a tax class', { taxClassId: 'Unknown tax class' });
  }
}

function productFields(data: ParsedProduct, manufacturerId: string | null) {
  return {
    name: data.name,
    name_key: nameKey(data.name),
    strength: data.strength,
    form: data.form,
    manufacturer_id: manufacturerId,
    sale_price: data.salePrice,
    price_qty: data.priceQty,
    cost_price: data.costPrice,
    tax_class_id: data.taxClassId,
    rx_required: bool(data.rxRequired),
    controlled_schedule: data.controlledSchedule,
    rack: data.rack,
    reorder_level: data.reorderLevel,
    notes: data.notes,
    allow_discount: bool(data.allowDiscount),
  };
}

/**
 * Inserts a product with its units, barcodes and ingredients inside `trx`.
 * Does not touch the search index; callers do (bulk import rebuilds it once).
 */
export async function insertProductTx(
  trx: Tx,
  ctx: AppContext,
  data: ParsedProduct,
  cache: LookupCache = newLookupCache(),
): Promise<string> {
  const now = timestamp(ctx);
  await assertTaxClass(trx, data.taxClassId);
  const manufacturerId = data.manufacturer
    ? await resolveNamed(trx, ctx, 'manufacturer', data.manufacturer, cache.manufacturers)
    : null;
  await assertNotDuplicate(trx, data, manufacturerId, null);
  await assertBarcodesFree(trx, data, null);

  const productId = ctx.newId();
  await insertRow(trx, now, 'product', {
    id: productId,
    ...productFields(data, manufacturerId),
    is_active: 1,
    created_at: now,
    updated_at: now,
  });

  for (const unit of data.units) {
    const unitId = ctx.newId();
    await insertRow(trx, now, 'product_unit', {
      id: unitId,
      product_id: productId,
      name: unit.name,
      qty: unit.qty,
      is_sellable: bool(unit.isSellable),
      is_active: 1,
      created_at: now,
      updated_at: now,
    });
    for (const barcode of unit.barcodes) {
      await insertRow(trx, now, 'product_barcode', {
        id: ctx.newId(),
        product_id: productId,
        unit_id: unitId,
        barcode,
        is_active: 1,
        created_at: now,
        updated_at: now,
      });
    }
  }

  for (const [index, ingredient] of data.ingredients.entries()) {
    await insertRow(trx, now, 'product_ingredient', {
      id: ctx.newId(),
      product_id: productId,
      generic_id: await resolveNamed(trx, ctx, 'generic', ingredient.generic, cache.generics),
      strength: ingredient.strength,
      sort_order: index,
      is_active: 1,
      created_at: now,
      updated_at: now,
    });
  }

  await audit(trx, ctx, {
    action: 'product.create',
    entityType: 'product',
    entityId: productId,
    after: { name: data.name, salePrice: data.salePrice, priceQty: data.priceQty },
  });
  return productId;
}

export async function createProduct(ctx: AppContext, input: ProductInput): Promise<ProductDetail> {
  const data = parseInput(productInputSchema, input);
  const id = await ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'catalog.edit');
    const productId = await insertProductTx(trx, ctx, data);
    await reindexProduct(trx, productId);
    return productId;
  });
  return requireProduct(ctx, id);
}

const PRICE_FIELDS = ['sale_price', 'price_qty', 'cost_price'] as const;

export async function updateProduct(
  ctx: AppContext,
  id: string,
  input: ProductInput,
  options: { reason?: string } = {},
): Promise<ProductDetail> {
  const data = parseInput(productInputSchema, input);
  const existing = await requireProduct(ctx, id);
  const cache = newLookupCache();

  await ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'catalog.edit');
    const now = timestamp(ctx);
    await assertTaxClass(trx, data.taxClassId);
    const manufacturerId = data.manufacturer
      ? await resolveNamed(trx, ctx, 'manufacturer', data.manufacturer, cache.manufacturers)
      : null;
    await assertNotDuplicate(trx, data, manufacturerId, id);
    await assertBarcodesFree(trx, data, id);

    const before = await trx
      .selectFrom('product')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const fields = productFields(data, manufacturerId);
    await updateRow(trx, now, 'product', id, fields);

    // Units: update the ones kept, add new ones, deactivate the rest.
    const existingUnitIds = new Set(existing.units.map((u) => u.id));
    const keptUnitIds = new Set<string>();
    const unitIdByIndex: string[] = [];
    for (const unit of data.units) {
      if (unit.id) {
        if (!existingUnitIds.has(unit.id)) {
          throw new AppError('VALIDATION', 'A unit does not belong to this product');
        }
        await updateRow(trx, now, 'product_unit', unit.id, {
          name: unit.name,
          qty: unit.qty,
          is_sellable: bool(unit.isSellable),
        });
        keptUnitIds.add(unit.id);
        unitIdByIndex.push(unit.id);
      } else {
        const unitId = ctx.newId();
        await insertRow(trx, now, 'product_unit', {
          id: unitId,
          product_id: id,
          name: unit.name,
          qty: unit.qty,
          is_sellable: bool(unit.isSellable),
          is_active: 1,
          created_at: now,
          updated_at: now,
        });
        unitIdByIndex.push(unitId);
      }
    }
    for (const unit of existing.units) {
      if (!keptUnitIds.has(unit.id)) {
        await updateRow(trx, now, 'product_unit', unit.id, { is_active: 0 });
      }
    }

    // Barcodes: keyed by the code itself.
    const wanted = new Map<string, string>();
    data.units.forEach((unit, i) => {
      for (const code of unit.barcodes) wanted.set(code, unitIdByIndex[i]!);
    });
    const current = await trx
      .selectFrom('product_barcode')
      .select(['id', 'barcode', 'unit_id'])
      .where('product_id', '=', id)
      .where('is_active', '=', 1)
      .execute();
    for (const row of current) {
      const unitId = wanted.get(row.barcode);
      if (!unitId) {
        await updateRow(trx, now, 'product_barcode', row.id, { is_active: 0 });
      } else if (unitId !== row.unit_id) {
        await updateRow(trx, now, 'product_barcode', row.id, { unit_id: unitId });
      }
      wanted.delete(row.barcode);
    }
    for (const [barcode, unitId] of wanted) {
      await insertRow(trx, now, 'product_barcode', {
        id: ctx.newId(),
        product_id: id,
        unit_id: unitId,
        barcode,
        is_active: 1,
        created_at: now,
        updated_at: now,
      });
    }

    // Ingredients: keyed by generic.
    const currentIngredients = await trx
      .selectFrom('product_ingredient')
      .select(['id', 'generic_id'])
      .where('product_id', '=', id)
      .where('is_active', '=', 1)
      .execute();
    const byGeneric = new Map(currentIngredients.map((row) => [row.generic_id, row.id]));
    for (const [index, ingredient] of data.ingredients.entries()) {
      const genericId = await resolveNamed(trx, ctx, 'generic', ingredient.generic, cache.generics);
      const rowId = byGeneric.get(genericId);
      if (rowId) {
        await updateRow(trx, now, 'product_ingredient', rowId, {
          strength: ingredient.strength,
          sort_order: index,
        });
        byGeneric.delete(genericId);
      } else {
        await insertRow(trx, now, 'product_ingredient', {
          id: ctx.newId(),
          product_id: id,
          generic_id: genericId,
          strength: ingredient.strength,
          sort_order: index,
          is_active: 1,
          created_at: now,
          updated_at: now,
        });
      }
    }
    for (const rowId of byGeneric.values()) {
      await updateRow(trx, now, 'product_ingredient', rowId, { is_active: 0 });
    }

    // Audit what changed on the product row; price changes get their own action.
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      const old = before[key as keyof typeof before];
      if (old !== value) {
        changedBefore[key] = old;
        changedAfter[key] = value;
      }
    }
    if (Object.keys(changedAfter).length > 0) {
      const priceChanged = PRICE_FIELDS.some((f) => f in changedAfter);
      await audit(trx, ctx, {
        action: priceChanged ? 'product.price_change' : 'product.update',
        entityType: 'product',
        entityId: id,
        before: changedBefore,
        after: changedAfter,
        reason: options.reason ?? null,
      });
    }

    await reindexProduct(trx, id);
  });

  return requireProduct(ctx, id);
}

/** Hides a product from search and checkout without losing its history. */
export async function setProductActive(
  ctx: AppContext,
  id: string,
  active: boolean,
): Promise<void> {
  await requireProduct(ctx, id);
  await ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'catalog.edit');
    const changed = await updateRow(trx, timestamp(ctx), 'product', id, {
      is_active: bool(active),
    });
    if (changed) {
      await audit(trx, ctx, {
        action: active ? 'product.restore' : 'product.archive',
        entityType: 'product',
        entityId: id,
      });
    }
  });
}
