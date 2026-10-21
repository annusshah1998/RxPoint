import {
  DEFAULT_BASE_UNIT,
  cleanText,
  defaultPackUnit,
  nameKey,
  parseExpiry,
  parseForm,
  parseMoney,
  pluralize,
  splitList,
  type IsoDate,
  type Money,
  type ProductForm,
} from '@app/core';
import Papa from 'papaparse';
import type { AppContext } from '../context';
import { validationError } from '../validation';
import { insertProductTx, newLookupCache, productInputSchema, type ParsedProduct } from './catalog';
import { rebuildSearchIndex } from './search';
import { listTaxClasses } from './setup';
import { insertOpeningStockTx } from './stock';

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export const IMPORT_FIELDS = {
  name: {
    label: 'Product name',
    aliases: [
      'product',
      'product name',
      'item',
      'item name',
      'brand',
      'brand name',
      'medicine',
      'description',
    ],
  },
  strength: { label: 'Strength', aliases: ['potency', 'dose'] },
  form: { label: 'Form', aliases: ['dosage form', 'type'] },
  generic: {
    label: 'Generic / salt',
    aliases: ['generic name', 'salt', 'salts', 'formula', 'composition', 'molecule'],
  },
  manufacturer: { label: 'Manufacturer', aliases: ['company', 'mfr', 'mfg', 'maker', 'principal'] },
  barcode: { label: 'Barcode', aliases: ['bar code', 'ean', 'gtin', 'upc'] },
  packSize: { label: 'Pack size', aliases: ['pack', 'packing', 'size'] },
  baseUnit: { label: 'Smallest unit', aliases: ['base unit', 'unit', 'uom'] },
  packUnit: { label: 'Pack unit', aliases: [] },
  boxUnit: { label: 'Box unit', aliases: [] },
  salePrice: {
    label: 'Sale price',
    aliases: ['price', 'retail price', 'selling price', 'rate', 'sp'],
  },
  priceUnit: { label: 'Price is per', aliases: ['price per', 'per'] },
  costPrice: { label: 'Cost price', aliases: ['cost', 'purchase price', 'tp', 'trade price'] },
  mrp: { label: 'MRP', aliases: ['max retail price', 'printed price'] },
  tax: { label: 'Tax class', aliases: ['tax class', 'gst'] },
  rxRequired: { label: 'Prescription required', aliases: ['rx', 'prescription', 'rx required'] },
  controlled: { label: 'Controlled schedule', aliases: ['schedule', 'controlled schedule'] },
  rack: { label: 'Rack', aliases: ['shelf', 'location', 'rack location'] },
  reorderLevel: { label: 'Reorder level', aliases: ['reorder', 'min stock', 'minimum stock'] },
  batchNo: { label: 'Batch no.', aliases: ['batch', 'batch number', 'lot', 'lot no'] },
  expiry: { label: 'Expiry', aliases: ['expiry date', 'exp', 'exp date', 'expires'] },
  stockQty: {
    label: 'Stock quantity',
    aliases: ['stock', 'qty', 'quantity', 'on hand', 'balance'],
  },
  stockUnit: { label: 'Stock is counted in', aliases: ['qty unit'] },
} as const satisfies Record<string, { label: string; aliases: string[] }>;

export type ImportField = keyof typeof IMPORT_FIELDS;
export const IMPORT_FIELD_KEYS = Object.keys(IMPORT_FIELDS) as ImportField[];

/** Column index for each field; missing fields aren't imported. */
export type ImportMapping = Partial<Record<ImportField, number>>;

/** "Sale_Price", "sale price", "SALE-PRICE." all become "sale price". */
function headerKey(header: string): string {
  return nameKey(header.replace(/[_\-.]+/g, ' ').replace(/\(.*?\)/g, ''));
}

function snake(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Matches spreadsheet headers to fields by name and common synonyms. */
export function guessMapping(headers: readonly string[]): ImportMapping {
  const keys = headers.map(headerKey);
  const mapping: ImportMapping = {};
  for (const field of IMPORT_FIELD_KEYS) {
    const { label, aliases } = IMPORT_FIELDS[field];
    const names = [field, snake(field), label, ...aliases].map(headerKey);
    const index = keys.findIndex(
      (key, i) => names.includes(key) && !Object.values(mapping).includes(i),
    );
    if (index >= 0) mapping[field] = index;
  }
  return mapping;
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy' });
  const [headers = [], ...rows] = result.data;
  return { headers: headers.map((h) => cleanText(h)), rows };
}

export const IMPORT_TEMPLATE_CSV = [
  'name,strength,form,generic,manufacturer,barcode,pack_size,sale_price,price_unit,cost_price,mrp,rx_required,controlled,rack,reorder_level,batch_no,expiry,stock_qty,stock_unit',
  'Sample Paracetamol,500mg,Tablet,Paracetamol,Sample Pharma,,20x10,520.00,Box,442.00,520.00,no,,A1,40,PC2401,06/2027,180,Tablet',
  'Sample Co-Amoxiclav,625mg,Tablet,Amoxicillin + Clavulanic Acid,Sample Pharma,,6,436.20,Strip,370.77,436.20,yes,,B2,12,CA1123,03/2027,4,Strip',
  'Sample Ibuprofen,100mg/5ml,Syrup,Ibuprofen,Sample Labs,,,120.00,Bottle,102.00,120.00,no,,C1,5,IB5521,11/2026,8,Bottle',
].join('\n');

// ---------------------------------------------------------------------------
// Cell readers
// ---------------------------------------------------------------------------

/**
 * Pack sizes as they appear on distributor price lists:
 *   "10", "10's", "10 tabs" → strips of 10
 *   "20x10", "20 x 10"     → box of 20 strips of 10
 *   "1x10"                 → strip of 10 (a box of one strip adds nothing)
 * Liquid volumes like "120ml" carry no pack information and are ignored.
 */
export function parsePackSize(
  text: string,
): { inner: number | null; outer: number | null } | 'ignored' | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return { inner: null, outer: null };
  let m = /^(\d+)(?:'?s|tabs?|caps?|pcs?)?$/.exec(t);
  if (m) return { inner: Number(m[1]), outer: null };
  m = /^(\d+)[x*](\d+)(?:'?s|tabs?|caps?|pcs?)?$/.exec(t);
  if (m) return { inner: Number(m[2]), outer: Number(m[1]) };
  if (/\d\s*(ml|l|g|gm|mg|kg)$/.test(t)) return 'ignored';
  return null;
}

const YES = new Set(['yes', 'y', 'true', '1', 'x', 'rx']);
const NO = new Set(['no', 'n', 'false', '0', '', '-', 'otc']);

function parseYesNo(text: string): boolean | null {
  const key = nameKey(text);
  if (YES.has(key)) return true;
  if (NO.has(key)) return false;
  return null;
}

/** Looks for a dosage form inside a product name such as "PANADOL TAB 500MG". */
function guessFormFromName(name: string): ProductForm | null {
  for (const word of nameKey(name).split(/[\s.,()/-]+/)) {
    const form = parseForm(word);
    if (form) return form;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Planning (dry run)
// ---------------------------------------------------------------------------

export interface ImportStockLine {
  batchNo: string;
  expiryDate: IsoDate | null;
  /** Base units. */
  qty: number;
  packQty: number;
  costPrice: Money | null;
  mrp: Money | null;
}

export interface ImportRowPlan {
  /** Row number as shown in a spreadsheet (header is row 1). */
  rowNumber: number;
  name: string;
  status: 'new' | 'existing' | 'error';
  /** Earlier row in this file that defines the same product; this row only adds stock. */
  repeatOf: number | null;
  productKey: string;
  product: ParsedProduct | null;
  existingProductId: string | null;
  stock: ImportStockLine | null;
  errors: string[];
  warnings: string[];
}

export interface ImportPlan {
  rows: ImportRowPlan[];
  counts: { newProducts: number; existingProducts: number; stockLines: number; errors: number };
}

function productKey(
  name: string,
  strength: string | null,
  manufacturer: string | null,
  form: string,
) {
  return [nameKey(name), nameKey(strength ?? ''), nameKey(manufacturer ?? ''), form].join('|');
}

/**
 * Reads every row and works out what importing it would do, without writing anything.
 * The person reviews this before running the import.
 */
export async function planImport(
  ctx: AppContext,
  csv: ParsedCsv,
  mapping: ImportMapping,
): Promise<ImportPlan> {
  // What's already in the catalog.
  const existing = await ctx.db
    .selectFrom('product as p')
    .leftJoin('manufacturer as m', 'm.id', 'p.manufacturer_id')
    .select(['p.id', 'p.name', 'p.strength', 'p.form', 'm.name as manufacturer'])
    .where('p.is_active', '=', 1)
    .execute();
  const existingByKey = new Map(
    existing.map((p) => [productKey(p.name, p.strength, p.manufacturer, p.form), p.id]),
  );
  const barcodeRows = await ctx.db
    .selectFrom('product_barcode as b')
    .innerJoin('product as p', 'p.id', 'b.product_id')
    .select(['b.barcode', 'b.product_id', 'p.name'])
    .where('b.is_active', '=', 1)
    .execute();
  const existingByBarcode = new Map(barcodeRows.map((b) => [b.barcode, b]));
  const taxClasses = await listTaxClasses(ctx);

  const firstRowForKey = new Map<string, number>();
  const barcodeOwnerInFile = new Map<string, string>();
  const rows: ImportRowPlan[] = [];

  csv.rows.forEach((cells, index) => {
    const rowNumber = index + 2;
    const cell = (field: ImportField) => {
      const i = mapping[field];
      return i === undefined ? '' : cleanText(cells[i] ?? '');
    };
    const errors: string[] = [];
    const warnings: string[] = [];

    const name = cell('name');
    if (!name) {
      rows.push({
        rowNumber,
        name: '',
        status: 'error',
        repeatOf: null,
        productKey: '',
        product: null,
        existingProductId: null,
        stock: null,
        errors: ['Missing product name'],
        warnings,
      });
      return;
    }

    // Form
    let form: ProductForm | null;
    if (cell('form')) {
      form = parseForm(cell('form'));
      if (!form) warnings.push(`Unknown form "${cell('form')}"; set to Other`);
    } else {
      form = guessFormFromName(name);
    }
    if (!form) {
      if (!cell('form')) warnings.push('No form given; set to Other');
      form = 'other';
    }

    // Units from pack size
    const baseName = cell('baseUnit') || DEFAULT_BASE_UNIT[form];
    const units: { name: string; qty: number; isSellable: boolean; barcodes: string[] }[] = [
      { name: baseName, qty: 1, isSellable: true, barcodes: [] },
    ];
    const pack = parsePackSize(cell('packSize'));
    if (pack === null) {
      errors.push(`Can't read pack size "${cell('packSize')}" (try 10 or 20x10)`);
    } else if (pack === 'ignored') {
      warnings.push(`Pack size "${cell('packSize')}" ignored; sold as single ${baseName}`);
    } else {
      const inner = pack.inner ?? 1;
      if (inner > 1) {
        units.push({
          name: cell('packUnit') || defaultPackUnit(form),
          qty: inner,
          isSellable: true,
          barcodes: [],
        });
      }
      if (pack.outer && pack.outer > 1) {
        units.push({
          name: cell('boxUnit') || 'Box',
          qty: inner * pack.outer,
          isSellable: true,
          barcodes: [],
        });
      }
    }
    const largest = units[units.length - 1]!;

    const findUnit = (text: string) => {
      const key = nameKey(text);
      if (!key) return null;
      if (['base', 'unit', 'single', 'loose'].includes(key)) return units[0]!;
      return (
        units.find((u) => nameKey(u.name) === key || nameKey(pluralize(u.name, 2)) === key) ??
        units.find((u) => nameKey(u.name).startsWith(key)) ??
        null
      );
    };

    // Price unit
    let priceUnit = largest;
    if (cell('priceUnit')) {
      const found = findUnit(cell('priceUnit'));
      if (found) priceUnit = found;
      else warnings.push(`Price unit "${cell('priceUnit')}" not found; using ${largest.name}`);
    }

    // Money
    const money = (field: ImportField, label: string): Money | null => {
      const text = cell(field);
      if (!text) return null;
      const value = parseMoney(text);
      if (value === null || value < 0) {
        errors.push(`Can't read ${label} "${text}"`);
        return null;
      }
      return value;
    };
    const salePrice = money('salePrice', 'sale price');
    const costPrice = money('costPrice', 'cost price');
    const mrp = money('mrp', 'MRP');
    if (salePrice === null && !cell('salePrice')) warnings.push('No sale price; set to 0');

    // Barcode → attach to the unit the price is for.
    const barcode = cell('barcode');
    if (barcode) priceUnit.barcodes.push(barcode);

    // Flags
    let rxRequired = false;
    if (cell('rxRequired')) {
      const value = parseYesNo(cell('rxRequired'));
      if (value === null) warnings.push(`Read prescription "${cell('rxRequired')}" as no`);
      rxRequired = value ?? false;
    }
    // A schedule letter (B, D …) marks a controlled drug; "no" or blank means not controlled.
    const controlledText = cell('controlled');
    const controlledFlag = parseYesNo(controlledText);
    let controlledSchedule: string | null = controlledFlag === null ? controlledText : null;
    if (controlledFlag === true) {
      errors.push('Controlled: give the schedule (e.g. B or D) instead of "yes"');
      controlledSchedule = null;
    }

    let taxClassId: string | null = null;
    if (cell('tax')) {
      const tax = taxClasses.find((t) => nameKey(t.name) === nameKey(cell('tax')));
      if (tax) taxClassId = tax.id;
      else warnings.push(`Tax class "${cell('tax')}" not found; left empty`);
    }

    let reorderLevel: number | null = null;
    if (cell('reorderLevel')) {
      const n = Number(cell('reorderLevel'));
      if (Number.isInteger(n) && n >= 0) reorderLevel = n;
      else warnings.push(`Reorder level "${cell('reorderLevel')}" ignored`);
    }

    // Generics: "Amoxicillin + Clavulanic Acid" with strength "500mg + 125mg".
    const generics = splitList(cell('generic'));
    const strengths = splitList(cell('strength'));
    const ingredients = generics.map((generic, i) => ({
      generic,
      strength: strengths.length === generics.length ? (strengths[i] ?? null) : null,
    }));

    const strength = cell('strength') || null;
    const manufacturer = cell('manufacturer') || null;
    const parsed = productInputSchema.safeParse({
      name,
      strength,
      form,
      manufacturer,
      ingredients,
      units,
      salePrice: salePrice ?? 0,
      priceQty: priceUnit.qty,
      costPrice,
      taxClassId,
      rxRequired,
      controlledSchedule,
      rack: cell('rack') || null,
      reorderLevel,
      notes: null,
    });
    let product: ParsedProduct | null = null;
    if (parsed.success) product = parsed.data;
    else errors.push(...Object.values(validationError(parsed.error).fields));

    // Which product is this?
    const key = productKey(name, strength, manufacturer, form);
    let existingProductId = existingByKey.get(key) ?? null;
    if (barcode) {
      const owner = existingByBarcode.get(barcode);
      if (owner) {
        if (existingProductId && existingProductId !== owner.product_id) {
          errors.push(`Barcode ${barcode} belongs to ${owner.name}`);
        } else if (!existingProductId) {
          existingProductId = owner.product_id;
          warnings.push(`Matched to existing product ${owner.name} by barcode`);
        }
      }
      const fileOwner = barcodeOwnerInFile.get(barcode);
      if (fileOwner && fileOwner !== key) errors.push(`Barcode ${barcode} is used by another row`);
      barcodeOwnerInFile.set(barcode, key);
    }
    const repeatOf = firstRowForKey.get(key) ?? null;
    if (repeatOf === null) firstRowForKey.set(key, rowNumber);

    // Opening stock
    let stock: ImportStockLine | null = null;
    const qtyText = cell('stockQty');
    if (qtyText) {
      const count = Number(qtyText.replace(/,/g, ''));
      if (!Number.isInteger(count) || count < 0) {
        errors.push(`Can't read stock quantity "${qtyText}" (use a whole number)`);
      } else if (count > 0) {
        let stockUnit = units[0]!;
        if (cell('stockUnit')) {
          const found = findUnit(cell('stockUnit'));
          if (found) stockUnit = found;
          else errors.push(`Stock unit "${cell('stockUnit')}" not found`);
        }
        let expiryDate: IsoDate | null = null;
        if (cell('expiry')) {
          expiryDate = parseExpiry(cell('expiry'));
          if (!expiryDate) errors.push(`Can't read expiry "${cell('expiry')}" (try 03/2027)`);
        } else {
          warnings.push('Stock has no expiry date');
        }
        if (!cell('batchNo')) warnings.push('Stock has no batch number');
        stock = {
          batchNo: cell('batchNo'),
          expiryDate,
          qty: count * stockUnit.qty,
          packQty: priceUnit.qty,
          costPrice,
          mrp,
        };
      }
    }

    const status: ImportRowPlan['status'] =
      errors.length > 0 ? 'error' : existingProductId ? 'existing' : 'new';
    rows.push({
      rowNumber,
      name,
      status,
      repeatOf,
      productKey: key,
      product,
      existingProductId,
      stock,
      errors,
      warnings,
    });
  });

  return {
    rows,
    counts: {
      newProducts: rows.filter((r) => r.status === 'new' && r.repeatOf === null).length,
      existingProducts: new Set(
        rows.filter((r) => r.status === 'existing').map((r) => r.existingProductId),
      ).size,
      stockLines: rows.filter((r) => r.status !== 'error' && r.stock).length,
      errors: rows.filter((r) => r.status === 'error').length,
    },
  };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface ImportResult {
  productsCreated: number;
  stockLinesAdded: number;
  failed: { rowNumber: number; error: string }[];
}

const CHUNK = 100;

/**
 * Imports the rows of a plan that have no errors. Rows are written in chunks, each in
 * one transaction; if a chunk fails, its rows are retried one by one so a single bad
 * row doesn't block the rest. Existing products are left as they are, but their stock
 * lines are added.
 */
export async function runImport(
  ctx: AppContext,
  plan: ImportPlan,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const rows = plan.rows.filter((r) => r.status !== 'error');
  const result: ImportResult = { productsCreated: 0, stockLinesAdded: 0, failed: [] };
  const createdIds = new Map<string, string>();
  const cache = newLookupCache();

  const importRows = async (batch: ImportRowPlan[]) =>
    ctx.db.transaction().execute(async (trx) => {
      const created = new Map<string, string>();
      let stockLines = 0;
      for (const row of batch) {
        let productId =
          row.existingProductId ?? createdIds.get(row.productKey) ?? created.get(row.productKey);
        if (!productId) {
          if (!row.product) throw new Error('Row has no product data');
          productId = await insertProductTx(trx, ctx, row.product, cache);
          created.set(row.productKey, productId);
        }
        if (row.stock) {
          await insertOpeningStockTx(trx, ctx, { productId, ...row.stock });
          stockLines++;
        }
      }
      return { created, stockLines };
    });

  const record = (outcome: { created: Map<string, string>; stockLines: number }) => {
    for (const [key, id] of outcome.created) createdIds.set(key, id);
    result.productsCreated += outcome.created.size;
    result.stockLinesAdded += outcome.stockLines;
  };

  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    try {
      record(await importRows(batch));
    } catch {
      // Lookup caches may hold ids from the rolled-back chunk.
      cache.manufacturers.clear();
      cache.generics.clear();
      for (const row of batch) {
        try {
          record(await importRows([row]));
        } catch (error) {
          cache.manufacturers.clear();
          cache.generics.clear();
          result.failed.push({
            rowNumber: row.rowNumber,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    onProgress?.(Math.min(i + CHUNK, rows.length), rows.length);
  }

  await rebuildSearchIndex(ctx.db);
  return result;
}
