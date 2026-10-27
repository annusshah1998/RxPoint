import type { GrantKind, PaymentMethod, UserRole, WalletProvider } from '@app/core';
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
  // Milestone 2 (0002-checkout)
  sale_draft: SaleDraftTable;
  draft_approval: DraftApprovalTable;
  pin_attempt: PinAttemptTable;
  backup_log: BackupLogTable;
  setting: SettingTable;
  shift: ShiftTable;
  cash_movement: CashMovementTable;
  sale: SaleTable;
  sale_line: SaleLineTable;
  sale_line_batch: SaleLineBatchTable;
  sale_prescription: SalePrescriptionTable;
  sale_void: SaleVoidTable;
  sale_return: SaleReturnTable;
  sale_return_line: SaleReturnLineTable;
  payment: PaymentTable;
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

/** The sale being rung up (one 'active' per till) and held sales. The sale gets this id. */
export interface SaleDraftTable {
  id: string;
  device_id: string;
  user_id: string;
  status: 'active' | 'held';
  label: string | null;
  cart_json: string;
  line_count: number;
  total: number;
  created_at: string;
  updated_at: string;
  held_at: string | null;
}

/** An approval given by PIN for one line (or the whole bill) of a draft. Deleted with the draft. */
export interface DraftApprovalTable {
  id: string;
  draft_id: string;
  kind: GrantKind;
  /** The line approved; '' for the whole bill. */
  line_key: string;
  /** What was approved, as it was (see grantScope in @app/core). */
  scope_json: string;
  /** For discounts: the discount approved (the need, not the approver's cap), in bp. */
  approved_bp: number | null;
  /** Who was selling: nobody else can use the approval. */
  requested_by: string;
  approver_id: string;
  created_at: string;
}

/** Wrong-PIN count and lockout per user. */
export interface PinAttemptTable {
  user_id: string;
  failed_count: number;
  locked_until: string | null;
  updated_at: string;
}

export type BackupKindValue = 'auto' | 'shift' | 'manual' | 'premigrate' | 'prerestore';

export interface BackupLogTable {
  id: string;
  kind: BackupKindValue;
  file_name: string;
  status: 'ok' | 'failed';
  size_bytes: number | null;
  outbox_seq: number | null;
  mirror_status: 'none' | 'ok' | 'failed';
  /** Why the copy to the mirror folder failed (0003); null unless mirror_status is 'failed'. */
  mirror_error: string | null;
  error: string | null;
  started_at: string;
  finished_at: string;
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
  /** 0 for items that are never discounted (e.g. formula milk). */
  allow_discount: Bool;
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
  /** 1 for the product's "Unrecorded stock" batch, which takes sales beyond recorded stock. */
  is_placeholder: Bool;
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
  /** Who approved it by PIN, when someone else had to. */
  approved_by: string | null;
  created_at: string;
}

/** One store setting; a missing key means the default from @app/config. */
export interface SettingTable extends Timestamps {
  id: string;
  branch_id: string;
  key: string;
  value_json: string;
}

export interface ShiftTable extends Timestamps {
  id: string;
  branch_id: string;
  device_id: string;
  shift_no: number;
  business_date: string;
  status: 'open' | 'closed';
  opened_by: string;
  opened_at: string;
  opening_float: number;
  closed_by: string | null;
  closed_at: string | null;
  expected_cash: number | null;
  counted_cash: number | null;
  /** counted − expected. */
  variance: number | null;
  /** Cash left in the drawer for the next shift. */
  float_left: number | null;
  count_json: string | null;
  close_note: string | null;
}

export type CashMovementCategory =
  'expense' | 'supplier' | 'staff' | 'owner' | 'bank' | 'change' | 'other';

/** Cash into or out of the drawer that isn't a sale. Signed: pay-outs are negative. */
export interface CashMovementTable {
  id: string;
  branch_id: string;
  device_id: string;
  shift_id: string;
  kind: 'pay_in' | 'pay_out';
  category: CashMovementCategory;
  amount: number;
  note: string;
  user_id: string;
  approved_by: string | null;
  created_at: string;
}

export type RxCheck = 'none' | 'seen' | 'not_seen';

/** A completed sale. Never changes; a void is a separate sale_void row. */
export interface SaleTable {
  id: string;
  branch_id: string;
  device_id: string;
  shift_id: string;
  invoice_seq: number;
  invoice_no: string;
  business_date: string;
  user_id: string;
  line_count: number;
  gross_total: number;
  line_discount_total: number;
  bill_discount_bp: number | null;
  bill_discount: number;
  /** gross − line discounts − bill discount. */
  subtotal: number;
  rounding: number;
  /** subtotal + rounding: what the customer pays. */
  total: number;
  /** Tax included in the total. */
  tax_total: number;
  change_given: number;
  cost_total: number | null;
  rx_check: RxCheck;
  approved_by: string | null;
  created_at: string;
}

export type PriceSource = 'catalog' | 'mrp' | 'override';
export type DiscountSource = 'none' | 'default' | 'manual';

export interface SaleLineTable {
  id: string;
  sale_id: string;
  line_no: number;
  product_id: string;
  unit_id: string;
  /** Product title as sold, e.g. "Panadol 500mg Tablet". */
  description: string;
  /** Base units. */
  qty: number;
  /** As shown, e.g. "2 Strips". */
  qty_text: string;
  /** Price charged: price_amount for price_qty base units. */
  price_amount: number;
  price_qty: number;
  price_source: PriceSource;
  price_reason: string | null;
  catalog_amount: number;
  catalog_qty: number;
  gross: number;
  discount_source: DiscountSource;
  line_discount_bp: number | null;
  line_discount: number;
  bill_discount_share: number;
  net: number;
  tax_class_id: string | null;
  tax_rate_bp: number;
  tax: number;
  cost: number | null;
  above_mrp: Bool;
  rx_required: Bool;
  controlled_schedule: string | null;
  approved_by: string | null;
  created_at: string;
}

export type BatchPick = 'fefo' | 'manual' | 'unrecorded';

/** Which batch a line took its units from, frozen as it was at sale time. */
export interface SaleLineBatchTable {
  id: string;
  sale_id: string;
  sale_line_id: string;
  batch_id: string;
  movement_id: string;
  qty: number;
  pick: BatchPick;
  stock_before: number;
  batch_no: string;
  expiry_date: string | null;
  cost: number | null;
  mrp: number | null;
  created_at: string;
}

export interface SalePrescriptionTable {
  id: string;
  sale_id: string;
  patient_name: string;
  patient_phone: string | null;
  prescriber_name: string;
  prescriber_reg_no: string | null;
  rx_date: string | null;
  rx_ref: string | null;
  dispensed_by: string;
  created_at: string;
}

export interface SaleVoidTable {
  id: string;
  sale_id: string;
  branch_id: string;
  device_id: string;
  shift_id: string;
  user_id: string;
  approved_by: string | null;
  reason: string;
  created_at: string;
}

export type ReturnReason =
  'wrong_item' | 'doctor_changed' | 'side_effect' | 'damaged' | 'expired' | 'other';

export interface SaleReturnTable {
  id: string;
  sale_id: string;
  branch_id: string;
  device_id: string;
  shift_id: string;
  return_seq: number;
  return_no: string;
  business_date: string;
  user_id: string;
  approved_by: string | null;
  reason: ReturnReason;
  note: string | null;
  refund_net: number;
  tax_total: number;
  rounding: number;
  refund_total: number;
  cost_total: number | null;
  created_at: string;
}

export interface SaleReturnLineTable {
  id: string;
  return_id: string;
  sale_line_id: string;
  sale_line_batch_id: string;
  batch_id: string;
  qty: number;
  refund: number;
  tax: number;
  cost: number | null;
  restock: Bool;
  movement_id: string | null;
  created_at: string;
}

export type PaymentDocType = 'sale' | 'void' | 'return';

/** Money in (+) or out (−) for a document, in the shift whose drawer it touched. */
export interface PaymentTable {
  id: string;
  branch_id: string;
  device_id: string;
  shift_id: string;
  sale_id: string;
  doc_type: PaymentDocType;
  doc_id: string;
  method: PaymentMethod;
  wallet_provider: WalletProvider | null;
  reference: string | null;
  amount: number;
  tendered: number | null;
  change_given: number | null;
  user_id: string;
  created_at: string;
}

export type ProductRow = Selectable<ProductTable>;
export type ProductUnitRow = Selectable<ProductUnitTable>;
export type BatchRow = Selectable<BatchTable>;
export type NewStockMovement = Insertable<StockMovementTable>;
export type ShiftRow = Selectable<ShiftTable>;
export type SaleRow = Selectable<SaleTable>;
export type SaleLineRow = Selectable<SaleLineTable>;
export type SaleLineBatchRow = Selectable<SaleLineBatchTable>;
export type PaymentRow = Selectable<PaymentTable>;
export type AppUserRow = Selectable<AppUserTable>;
