import { appendOnly, bool, isDate } from './sql';
import type { Migration } from './types';

const timestamps = `
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL`;

/**
 * Milestone 2: users and approvals, settings, shifts and cash, sales with their batch
 * allocations and signed payments, voids, returns, drafts and backups.
 *
 * Triggers here only enforce rules that hold for ANY order of valid history (append-only,
 * a closed shift is final, no over-return, …), so a future cloud restore can replay rows
 * in any order. Rules that depend on order (documents only into an open shift, cash
 * refunds within the drawer) live in the services and in checkRecords().
 */
export const checkout: Migration = {
  id: '0002-checkout',
  statements: [
    // ---- Changes to M1 tables (ADD COLUMN only) ----
    `ALTER TABLE product ADD COLUMN ${bool('allow_discount')} DEFAULT 1`,
    // One "Unrecorded stock" batch per product takes sales beyond recorded stock.
    `ALTER TABLE batch ADD COLUMN ${bool('is_placeholder')} DEFAULT 0`,
    `CREATE UNIQUE INDEX batch_placeholder_uq ON batch (product_id) WHERE is_placeholder = 1`,
    `ALTER TABLE audit_log ADD COLUMN approved_by TEXT REFERENCES app_user (id)`,
    `CREATE INDEX audit_log_action_idx ON audit_log (action, created_at)`,

    // ---- Local-only ----
    // The sale being rung up (one 'active' per till) and held sales. completeSale stores the
    // sale with this id and deletes the row.
    `CREATE TABLE sale_draft (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES device (id),
      user_id TEXT NOT NULL REFERENCES app_user (id),
      status TEXT NOT NULL CHECK (status IN ('active', 'held')),
      label TEXT CHECK (label IS NULL OR length(label) <= 60),
      cart_json TEXT NOT NULL CHECK (json_valid(cart_json)),
      line_count INTEGER NOT NULL CHECK (line_count >= 0),
      total INTEGER NOT NULL CHECK (total >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      held_at TEXT,
      CHECK ((status = 'held') = (held_at IS NOT NULL))
    ) STRICT`,
    `CREATE UNIQUE INDEX sale_draft_one_active_uq ON sale_draft (device_id) WHERE status = 'active'`,

    // Written only after the approver's PIN was checked. A grant covers exactly what was
    // approved (scope_json: the line or bill as it was), so a later change needs a new PIN.
    `CREATE TABLE draft_approval (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL REFERENCES sale_draft (id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('sale.discount', 'sale.controlled', 'sale.price_override')),
      line_key TEXT NOT NULL,
      scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
      approved_bp INTEGER CHECK (approved_bp BETWEEN 0 AND 10000),
      requested_by TEXT NOT NULL REFERENCES app_user (id),
      approver_id TEXT NOT NULL REFERENCES app_user (id),
      created_at TEXT NOT NULL,
      CHECK ((kind = 'sale.discount') = (approved_bp IS NOT NULL)),
      CHECK (approver_id <> requested_by)
    ) STRICT`,
    `CREATE UNIQUE INDEX draft_approval_scope_uq ON draft_approval (draft_id, kind, line_key)`,

    `CREATE TABLE pin_attempt (
      user_id TEXT PRIMARY KEY REFERENCES app_user (id),
      failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
      locked_until TEXT,
      updated_at TEXT NOT NULL
    ) STRICT`,

    `CREATE TABLE backup_log (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('auto', 'shift', 'manual', 'premigrate', 'prerestore')),
      file_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
      size_bytes INTEGER CHECK (size_bytes >= 0),
      outbox_seq INTEGER,
      mirror_status TEXT NOT NULL CHECK (mirror_status IN ('none', 'ok', 'failed')),
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX backup_log_started_idx ON backup_log (started_at)`,

    // ---- Store settings (a missing key means the default from @app/config) ----
    `CREATE TABLE setting (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL REFERENCES branch (id),
      key TEXT NOT NULL,
      value_json TEXT NOT NULL CHECK (json_valid(value_json)),${timestamps}
    ) STRICT`,
    `CREATE UNIQUE INDEX setting_key_uq ON setting (branch_id, key)`,

    // ---- Shifts and cash ----
    `CREATE TABLE shift (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL REFERENCES branch (id),
      device_id TEXT NOT NULL REFERENCES device (id),
      shift_no INTEGER NOT NULL CHECK (shift_no > 0),
      business_date TEXT NOT NULL CHECK (${isDate('business_date')}),
      status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
      opened_by TEXT NOT NULL REFERENCES app_user (id),
      opened_at TEXT NOT NULL,
      opening_float INTEGER NOT NULL CHECK (opening_float >= 0),
      closed_by TEXT REFERENCES app_user (id),
      closed_at TEXT,
      expected_cash INTEGER,
      counted_cash INTEGER CHECK (counted_cash >= 0),
      variance INTEGER,
      float_left INTEGER CHECK (float_left >= 0),
      count_json TEXT CHECK (count_json IS NULL OR json_valid(count_json)),
      close_note TEXT,${timestamps},
      CHECK (
        (status = 'open' AND closed_at IS NULL AND closed_by IS NULL AND expected_cash IS NULL
          AND counted_cash IS NULL AND variance IS NULL AND float_left IS NULL)
        OR (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL
          AND expected_cash IS NOT NULL AND counted_cash IS NOT NULL
          AND variance = counted_cash - expected_cash
          AND float_left IS NOT NULL AND float_left <= counted_cash)
      )
    ) STRICT`,
    `CREATE UNIQUE INDEX shift_one_open_uq ON shift (device_id) WHERE status = 'open'`,
    `CREATE UNIQUE INDEX shift_no_uq ON shift (device_id, shift_no)`,
    `CREATE INDEX shift_date_idx ON shift (branch_id, business_date)`,
    // How a shift opened never changes, and a closed shift never changes at all.
    `CREATE TRIGGER shift_guard BEFORE UPDATE ON shift
     WHEN OLD.status = 'closed'
       OR NEW.branch_id IS NOT OLD.branch_id OR NEW.device_id IS NOT OLD.device_id
       OR NEW.shift_no IS NOT OLD.shift_no OR NEW.business_date IS NOT OLD.business_date
       OR NEW.opened_by IS NOT OLD.opened_by OR NEW.opened_at IS NOT OLD.opened_at
       OR NEW.opening_float IS NOT OLD.opening_float
     BEGIN SELECT RAISE(ABORT, 'A closed shift, or how a shift opened, cannot change'); END`,
    `CREATE TRIGGER shift_no_delete BEFORE DELETE ON shift
     BEGIN SELECT RAISE(ABORT, 'shift rows are never deleted'); END`,

    `CREATE TABLE cash_movement (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL REFERENCES branch (id),
      device_id TEXT NOT NULL REFERENCES device (id),
      shift_id TEXT NOT NULL REFERENCES shift (id),
      kind TEXT NOT NULL CHECK (kind IN ('pay_in', 'pay_out')),
      category TEXT NOT NULL CHECK (category IN ('expense', 'supplier', 'staff', 'owner', 'bank', 'change', 'other')),
      amount INTEGER NOT NULL CHECK ((kind = 'pay_in' AND amount > 0) OR (kind = 'pay_out' AND amount < 0)),
      note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 200),
      user_id TEXT NOT NULL REFERENCES app_user (id),
      approved_by TEXT REFERENCES app_user (id),
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX cash_movement_shift_idx ON cash_movement (shift_id)`,
    ...appendOnly('cash_movement'),

    // ---- Sales ----
    `CREATE TABLE sale (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL REFERENCES branch (id),
      device_id TEXT NOT NULL REFERENCES device (id),
      shift_id TEXT NOT NULL REFERENCES shift (id),
      invoice_seq INTEGER NOT NULL CHECK (invoice_seq > 0),
      invoice_no TEXT NOT NULL,
      business_date TEXT NOT NULL CHECK (${isDate('business_date')}),
      user_id TEXT NOT NULL REFERENCES app_user (id),
      line_count INTEGER NOT NULL CHECK (line_count > 0),
      gross_total INTEGER NOT NULL CHECK (gross_total >= 0),
      line_discount_total INTEGER NOT NULL CHECK (line_discount_total >= 0),
      bill_discount_bp INTEGER CHECK (bill_discount_bp BETWEEN 0 AND 10000),
      bill_discount INTEGER NOT NULL CHECK (bill_discount >= 0),
      subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
      rounding INTEGER NOT NULL CHECK (rounding BETWEEN -1000 AND 1000),
      total INTEGER NOT NULL CHECK (total >= 0),
      tax_total INTEGER NOT NULL CHECK (tax_total BETWEEN 0 AND subtotal),
      change_given INTEGER NOT NULL CHECK (change_given >= 0),
      cost_total INTEGER CHECK (cost_total >= 0),
      rx_check TEXT NOT NULL CHECK (rx_check IN ('none', 'seen', 'not_seen')),
      approved_by TEXT REFERENCES app_user (id),
      created_at TEXT NOT NULL,
      CHECK (subtotal = gross_total - line_discount_total - bill_discount),
      CHECK (total = subtotal + rounding)
    ) STRICT`,
    `CREATE UNIQUE INDEX sale_invoice_uq ON sale (device_id, invoice_seq)`,
    `CREATE INDEX sale_invoice_no_idx ON sale (invoice_no)`,
    `CREATE INDEX sale_shift_idx ON sale (shift_id)`,
    `CREATE INDEX sale_date_idx ON sale (branch_id, business_date)`,
    ...appendOnly('sale'),

    `CREATE TABLE sale_line (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sale (id),
      line_no INTEGER NOT NULL CHECK (line_no > 0),
      product_id TEXT NOT NULL REFERENCES product (id),
      unit_id TEXT NOT NULL REFERENCES product_unit (id),
      description TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      qty_text TEXT NOT NULL,
      price_amount INTEGER NOT NULL CHECK (price_amount >= 0),
      price_qty INTEGER NOT NULL CHECK (price_qty > 0),
      price_source TEXT NOT NULL CHECK (price_source IN ('catalog', 'mrp', 'override')),
      price_reason TEXT,
      catalog_amount INTEGER NOT NULL CHECK (catalog_amount >= 0),
      catalog_qty INTEGER NOT NULL CHECK (catalog_qty > 0),
      gross INTEGER NOT NULL CHECK (gross >= 0),
      discount_source TEXT NOT NULL CHECK (discount_source IN ('none', 'default', 'manual')),
      line_discount_bp INTEGER CHECK (line_discount_bp BETWEEN 0 AND 10000),
      line_discount INTEGER NOT NULL CHECK (line_discount BETWEEN 0 AND gross),
      bill_discount_share INTEGER NOT NULL CHECK (bill_discount_share >= 0),
      net INTEGER NOT NULL CHECK (net >= 0),
      tax_class_id TEXT REFERENCES tax_class (id),
      tax_rate_bp INTEGER NOT NULL CHECK (tax_rate_bp BETWEEN 0 AND 10000),
      tax INTEGER NOT NULL CHECK (tax BETWEEN 0 AND net),
      cost INTEGER CHECK (cost >= 0),
      ${bool('above_mrp')},
      ${bool('rx_required')},
      controlled_schedule TEXT,
      approved_by TEXT REFERENCES app_user (id),
      created_at TEXT NOT NULL,
      CHECK (net = gross - line_discount - bill_discount_share),
      CHECK (price_source <> 'override' OR price_reason IS NOT NULL)
    ) STRICT`,
    `CREATE UNIQUE INDEX sale_line_no_uq ON sale_line (sale_id, line_no)`,
    `CREATE INDEX sale_line_product_idx ON sale_line (product_id, created_at)`,
    ...appendOnly('sale_line'),

    // One row per batch a line took from, with what was true at sale time.
    `CREATE TABLE sale_line_batch (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sale (id),
      sale_line_id TEXT NOT NULL REFERENCES sale_line (id),
      batch_id TEXT NOT NULL REFERENCES batch (id),
      movement_id TEXT NOT NULL REFERENCES stock_movement (id),
      qty INTEGER NOT NULL CHECK (qty > 0),
      pick TEXT NOT NULL CHECK (pick IN ('fefo', 'manual', 'unrecorded')),
      stock_before INTEGER NOT NULL,
      batch_no TEXT NOT NULL,
      expiry_date TEXT CHECK (expiry_date IS NULL OR ${isDate('expiry_date')}),
      cost INTEGER CHECK (cost >= 0),
      mrp INTEGER CHECK (mrp >= 0),
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX sale_line_batch_line_idx ON sale_line_batch (sale_line_id)`,
    `CREATE INDEX sale_line_batch_batch_idx ON sale_line_batch (batch_id)`,
    `CREATE UNIQUE INDEX sale_line_batch_movement_uq ON sale_line_batch (movement_id)`,
    ...appendOnly('sale_line_batch'),
    // Replay-safe: compares two frozen values (this row's expiry snapshot and the sale's date).
    `CREATE TRIGGER sale_line_batch_not_expired BEFORE INSERT ON sale_line_batch
     WHEN NEW.expiry_date IS NOT NULL
      AND NEW.expiry_date < (SELECT business_date FROM sale WHERE id = NEW.sale_id)
     BEGIN SELECT RAISE(ABORT, 'Expired stock cannot be sold'); END`,

    `CREATE TABLE sale_prescription (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sale (id),
      patient_name TEXT NOT NULL CHECK (length(patient_name) BETWEEN 1 AND 80),
      patient_phone TEXT,
      prescriber_name TEXT NOT NULL CHECK (length(prescriber_name) BETWEEN 1 AND 80),
      prescriber_reg_no TEXT,
      rx_date TEXT CHECK (rx_date IS NULL OR ${isDate('rx_date')}),
      rx_ref TEXT,
      dispensed_by TEXT NOT NULL REFERENCES app_user (id),
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE UNIQUE INDEX sale_prescription_sale_uq ON sale_prescription (sale_id)`,
    ...appendOnly('sale_prescription'),

    `CREATE TABLE sale_void (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sale (id),
      branch_id TEXT NOT NULL REFERENCES branch (id),
      device_id TEXT NOT NULL REFERENCES device (id),
      shift_id TEXT NOT NULL REFERENCES shift (id),
      user_id TEXT NOT NULL REFERENCES app_user (id),
      approved_by TEXT REFERENCES app_user (id),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE UNIQUE INDEX sale_void_sale_uq ON sale_void (sale_id)`,
    ...appendOnly('sale_void'),

    `CREATE TABLE sale_return (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sale (id),
      branch_id TEXT NOT NULL REFERENCES branch (id),
      device_id TEXT NOT NULL REFERENCES device (id),
      shift_id TEXT NOT NULL REFERENCES shift (id),
      return_seq INTEGER NOT NULL CHECK (return_seq > 0),
      return_no TEXT NOT NULL,
      business_date TEXT NOT NULL CHECK (${isDate('business_date')}),
      user_id TEXT NOT NULL REFERENCES app_user (id),
      approved_by TEXT REFERENCES app_user (id),
      reason TEXT NOT NULL CHECK (reason IN ('wrong_item', 'doctor_changed', 'side_effect', 'damaged', 'expired', 'other')),
      note TEXT,
      refund_net INTEGER NOT NULL CHECK (refund_net >= 0),
      tax_total INTEGER NOT NULL CHECK (tax_total BETWEEN 0 AND refund_net),
      rounding INTEGER NOT NULL CHECK (rounding BETWEEN -1000 AND 1000),
      refund_total INTEGER NOT NULL CHECK (refund_total >= 0),
      cost_total INTEGER CHECK (cost_total >= 0),
      created_at TEXT NOT NULL,
      CHECK (refund_total = refund_net + rounding)
    ) STRICT`,
    `CREATE UNIQUE INDEX sale_return_seq_uq ON sale_return (device_id, return_seq)`,
    `CREATE INDEX sale_return_sale_idx ON sale_return (sale_id)`,
    `CREATE INDEX sale_return_shift_idx ON sale_return (shift_id)`,
    ...appendOnly('sale_return'),

    // One row per returned piece of one allocation.
    `CREATE TABLE sale_return_line (
      id TEXT PRIMARY KEY,
      return_id TEXT NOT NULL REFERENCES sale_return (id),
      sale_line_id TEXT NOT NULL REFERENCES sale_line (id),
      sale_line_batch_id TEXT NOT NULL REFERENCES sale_line_batch (id),
      batch_id TEXT NOT NULL REFERENCES batch (id),
      qty INTEGER NOT NULL CHECK (qty > 0),
      refund INTEGER NOT NULL CHECK (refund >= 0),
      tax INTEGER NOT NULL CHECK (tax BETWEEN 0 AND refund),
      cost INTEGER CHECK (cost >= 0),
      ${bool('restock')},
      movement_id TEXT REFERENCES stock_movement (id),
      created_at TEXT NOT NULL,
      CHECK ((restock = 1) = (movement_id IS NOT NULL))
    ) STRICT`,
    `CREATE INDEX sale_return_line_return_idx ON sale_return_line (return_id)`,
    `CREATE INDEX sale_return_line_slb_idx ON sale_return_line (sale_line_batch_id)`,
    ...appendOnly('sale_return_line'),

    // Every rupee in or out for a document, signed, in the shift whose drawer it touched.
    `CREATE TABLE payment (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL REFERENCES branch (id),
      device_id TEXT NOT NULL REFERENCES device (id),
      shift_id TEXT NOT NULL REFERENCES shift (id),
      sale_id TEXT NOT NULL REFERENCES sale (id),
      doc_type TEXT NOT NULL CHECK (doc_type IN ('sale', 'void', 'return')),
      doc_id TEXT NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'wallet', 'khata')),
      wallet_provider TEXT CHECK (wallet_provider IN ('jazzcash', 'easypaisa', 'raast', 'other')),
      reference TEXT CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 40),
      amount INTEGER NOT NULL CHECK (amount <> 0),
      tendered INTEGER,
      change_given INTEGER,
      user_id TEXT NOT NULL REFERENCES app_user (id),
      created_at TEXT NOT NULL,
      CHECK ((doc_type = 'sale') = (amount > 0)),
      CHECK (doc_type <> 'sale' OR doc_id = sale_id),
      CHECK ((method = 'wallet') = (wallet_provider IS NOT NULL)),
      CHECK (method <> 'wallet' OR doc_type <> 'sale' OR length(trim(COALESCE(reference, ''))) >= 4),
      CHECK ((tendered IS NULL) = (change_given IS NULL)),
      CHECK (tendered IS NULL OR (method = 'cash' AND doc_type = 'sale'
             AND change_given >= 0 AND tendered - change_given = amount))
    ) STRICT`,
    `CREATE INDEX payment_shift_idx ON payment (shift_id, method)`,
    `CREATE INDEX payment_sale_idx ON payment (sale_id)`,
    ...appendOnly('payment'),

    // ---- Guards that hold for any order of valid history ----
    `CREATE TRIGGER sale_void_guard BEFORE INSERT ON sale_void
     WHEN NEW.shift_id IS NOT (SELECT shift_id FROM sale WHERE id = NEW.sale_id)
       OR EXISTS (SELECT 1 FROM sale_return WHERE sale_id = NEW.sale_id)
     BEGIN SELECT RAISE(ABORT, 'Only a sale from the same shift with no returns can be voided'); END`,
    `CREATE TRIGGER sale_return_not_voided BEFORE INSERT ON sale_return
     WHEN EXISTS (SELECT 1 FROM sale_void WHERE sale_id = NEW.sale_id)
     BEGIN SELECT RAISE(ABORT, 'A voided sale cannot be returned'); END`,
    `CREATE TRIGGER sale_return_line_guard BEFORE INSERT ON sale_return_line
     WHEN (SELECT sale_id FROM sale_line WHERE id = NEW.sale_line_id)
            IS NOT (SELECT sale_id FROM sale_return WHERE id = NEW.return_id)
       OR (SELECT sale_line_id FROM sale_line_batch WHERE id = NEW.sale_line_batch_id) IS NOT NEW.sale_line_id
       OR (SELECT batch_id FROM sale_line_batch WHERE id = NEW.sale_line_batch_id) IS NOT NEW.batch_id
       OR NEW.qty + COALESCE((SELECT SUM(qty) FROM sale_return_line
                              WHERE sale_line_batch_id = NEW.sale_line_batch_id), 0)
          > (SELECT qty FROM sale_line_batch WHERE id = NEW.sale_line_batch_id)
     BEGIN SELECT RAISE(ABORT, 'Cannot return more than was sold from this batch'); END`,
  ],
};
