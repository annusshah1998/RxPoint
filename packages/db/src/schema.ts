import type { Generated, Insertable, Selectable } from 'kysely';

/**
 * TypeScript view of the SQLite schema in ./migrations. Keep the two in step.
 *
 * Conventions:
 *   - ids are UUIDv7 text
 *   - money columns are whole minor units (paisa)
 *   - quantities are whole base units (e.g. tablets)
 *   - booleans are 0/1
 *   - timestamps are ISO 8601 UTC text; calendar dates are 'YYYY-MM-DD'
 */
export type Bool = 0 | 1;

export interface DB {
  local_meta: LocalMetaTable;
  sync_outbox: SyncOutboxTable;
  branch: BranchTable;
  device: DeviceTable;
  app_user: AppUserTable;
  tax_class: TaxClassTable;
  manufacturer: ManufacturerTable;
  generic: GenericTable;
  product: ProductTable;
  product_unit: ProductUnitTable;
  product_barcode: ProductBarcodeTable;
  product_ingredient: ProductIngredientTable;
  batch: BatchTable;
  stock_movement: StockMovementTable;
  batch_stock: BatchStockTable;
  audit_log: AuditLogTable;
  product_fts: ProductFtsTable;
  schema_migration: SchemaMigrationTable;
}

// ---- Local-only tables (never synced) ----

export interface SchemaMigrationTable {
  id: string;
  applied_at: string;
}

/** Facts about this installation: which branch and device it is. */
export interface LocalMetaTable {
  key: string;
  value: string;
}

/** Every change to a synced table, queued in the same transaction for upload (M6). */
export interface SyncOutboxTable {
  seq: Generated<number>;
  table_name: string;
  row_id: string;
  op: 'insert' | 'update';
  payload: string;
  created_at: string;
  sent_at: string | null;
}

/** Stock on hand per batch, derived from stock_movement by a trigger. Rebuildable. */
export interface BatchStockTable {
  branch_id: string;
  batch_id: string;
  product_id: string;
  qty: number;
}

/** Full-text search index over products, rebuilt from the product tables. */
export interface ProductFtsTable {
  product_id: string;
  name: string;
  generics: string;
  strength: string;
  form: string;
  manufacturer: string;
}

// ---- Synced tables ----

interface Timestamps {
  created_at: string;
  updated_at: string;
}

export interface BranchTable extends Timestamps {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  ntn: string | null;
  strn: string | null;
  drug_license_no: string | null;
}

export interface DeviceTable extends Timestamps {
  id: string;
  branch_id: string;
  code: string;
  name: string;
}

export type UserRole = 'owner' | 'pharmacist' | 'cashier' | 'inventory';

export interface AppUserTable extends Timestamps {
  id: string;
  name: string;
  role: UserRole;
  pin_hash: string | null;
  is_active: Bool;
}

export interface TaxClassTable extends Timestamps {
  id: string;
  name: string;
  /** Basis points: 1800 = 18%. */
  rate_bp: number;
  is_active: Bool;
}

export interface ManufacturerTable extends Timestamps {
  id: string;
  name: string;
  name_key: string;
}

/** A molecule / salt, e.g. "Amoxicillin". */
export interface GenericTable extends Timestamps {
  id: string;
  name: string;
  name_key: string;
}

export interface ProductTable extends Timestamps {
  id: string;
  /** Brand name as printed, e.g. "Augmentin". */
  name: string;
  name_key: string;
  /** e.g. "625mg" */
  strength: string | null;
  form: string;
  manufacturer_id: string | null;
  /** Sale price for `price_qty` base units (e.g. per box of 30). */
  sale_price: number;
  price_qty: number;
  /** Usual cost for `price_qty` base units; actual cost lives on each batch. */
  cost_price: number | null;
  tax_class_id: string | null;
  rx_required: Bool;
  /** Controlled-drug schedule (e.g. 'B' or 'D' under the Punjab Drugs Rules); null if not controlled. */
  controlled_schedule: string | null;
  rack: string | null;
  /** In base units. */
  reorder_level: number | null;
  notes: string | null;
  is_active: Bool;
}

export interface ProductUnitTable extends Timestamps {
  id: string;
  product_id: string;
  name: string;
  /** Base units in one of this unit; the base unit has qty 1. */
  qty: number;
  is_sellable: Bool;
  is_active: Bool;
}

export interface ProductBarcodeTable extends Timestamps {
  id: string;
  product_id: string;
  unit_id: string;
  barcode: string;
  is_active: Bool;
}

export interface ProductIngredientTable extends Timestamps {
  id: string;
  product_id: string;
  generic_id: string;
  strength: string | null;
  sort_order: number;
  is_active: Bool;
}

export type BatchSource = 'opening' | 'purchase' | 'adjustment';

/**
 * One lot of stock as received. The same printed batch number can appear in
 * several rows (e.g. received twice at different costs).
 */
export interface BatchTable extends Timestamps {
  id: string;
  product_id: string;
  /** As printed on the pack; '' when unknown. */
  batch_no: string;
  expiry_date: string | null;
  /** Base units that cost_price and mrp refer to. */
  pack_qty: number;
  cost_price: number | null;
  /** Maximum retail price printed on this batch. */
  mrp: number | null;
  source: BatchSource;
}

export type MovementKind =
  | 'opening'
  | 'receive'
  | 'sale'
  | 'sale_return'
  | 'supplier_return'
  | 'adjustment'
  | 'count'
  | 'expiry_writeoff'
  | 'transfer_in'
  | 'transfer_out';

/** Append-only stock ledger. Stock on hand = sum of qty per batch. */
export interface StockMovementTable {
  id: string;
  branch_id: string;
  device_id: string;
  product_id: string;
  batch_id: string;
  /** Signed base units: + in, - out. */
  qty: number;
  kind: MovementKind;
  ref_type: string | null;
  ref_id: string | null;
  reason: string | null;
  user_id: string | null;
  created_at: string;
}

/** Append-only record of sensitive changes (prices, stock edits, voids, discounts). */
export interface AuditLogTable {
  id: string;
  branch_id: string | null;
  device_id: string | null;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  created_at: string;
}

export type ProductRow = Selectable<ProductTable>;
export type ProductUnitRow = Selectable<ProductUnitTable>;
export type BatchRow = Selectable<BatchTable>;
export type NewStockMovement = Insertable<StockMovementTable>;
