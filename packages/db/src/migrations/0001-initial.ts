import type { Migration } from './types';

const timestamps = `
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL`;

const appendOnly = (table: string) => [
  `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
   BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
  `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
   BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
];

const bool = (column: string) => `${column} INTEGER NOT NULL CHECK (${column} IN (0, 1))`;

export const initial: Migration = {
  id: '0001-initial',
  statements: [
    // ---- Local-only ----
    `CREATE TABLE local_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT`,

    `CREATE TABLE sync_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('insert', 'update')),
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    ) STRICT`,
    `CREATE INDEX sync_outbox_unsent_idx ON sync_outbox (seq) WHERE sent_at IS NULL`,

    // ---- Store, devices, people ----
    `CREATE TABLE branch (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      ntn TEXT,
      strn TEXT,
      drug_license_no TEXT,${timestamps}
    ) STRICT`,

    `CREATE TABLE device (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL REFERENCES branch (id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,${timestamps}
    ) STRICT`,

    `CREATE TABLE app_user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'pharmacist', 'cashier', 'inventory')),
      pin_hash TEXT,
      ${bool('is_active')},${timestamps}
    ) STRICT`,

    // ---- Catalog ----
    `CREATE TABLE tax_class (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
      ${bool('is_active')},${timestamps}
    ) STRICT`,

    `CREATE TABLE manufacturer (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,${timestamps}
    ) STRICT`,
    `CREATE UNIQUE INDEX manufacturer_name_key_uq ON manufacturer (name_key)`,

    `CREATE TABLE generic (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,${timestamps}
    ) STRICT`,
    `CREATE UNIQUE INDEX generic_name_key_uq ON generic (name_key)`,

    `CREATE TABLE product (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      strength TEXT,
      form TEXT NOT NULL,
      manufacturer_id TEXT REFERENCES manufacturer (id),
      sale_price INTEGER NOT NULL CHECK (sale_price >= 0),
      price_qty INTEGER NOT NULL CHECK (price_qty > 0),
      cost_price INTEGER CHECK (cost_price >= 0),
      tax_class_id TEXT REFERENCES tax_class (id),
      ${bool('rx_required')},
      controlled_schedule TEXT,
      rack TEXT,
      reorder_level INTEGER CHECK (reorder_level >= 0),
      notes TEXT,
      ${bool('is_active')},${timestamps}
    ) STRICT`,
    `CREATE INDEX product_name_key_idx ON product (name_key)`,

    `CREATE TABLE product_unit (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES product (id),
      name TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      ${bool('is_sellable')},
      ${bool('is_active')},${timestamps}
    ) STRICT`,
    `CREATE INDEX product_unit_product_idx ON product_unit (product_id)`,

    `CREATE TABLE product_barcode (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES product (id),
      unit_id TEXT NOT NULL REFERENCES product_unit (id),
      barcode TEXT NOT NULL,
      ${bool('is_active')},${timestamps}
    ) STRICT`,
    `CREATE UNIQUE INDEX product_barcode_active_uq ON product_barcode (barcode) WHERE is_active = 1`,
    `CREATE INDEX product_barcode_product_idx ON product_barcode (product_id)`,

    `CREATE TABLE product_ingredient (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES product (id),
      generic_id TEXT NOT NULL REFERENCES generic (id),
      strength TEXT,
      sort_order INTEGER NOT NULL,
      ${bool('is_active')},${timestamps}
    ) STRICT`,
    `CREATE INDEX product_ingredient_product_idx ON product_ingredient (product_id)`,
    `CREATE INDEX product_ingredient_generic_idx ON product_ingredient (generic_id)`,

    // Trigram index: any 3+ letters of a brand, salt, strength, form or maker match.
    `CREATE VIRTUAL TABLE product_fts USING fts5 (
      product_id UNINDEXED,
      name,
      generics,
      strength,
      form,
      manufacturer,
      tokenize = 'trigram'
    )`,

    // ---- Stock ----
    `CREATE TABLE batch (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES product (id),
      batch_no TEXT NOT NULL,
      expiry_date TEXT CHECK (
        expiry_date IS NULL OR expiry_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
      ),
      pack_qty INTEGER NOT NULL CHECK (pack_qty > 0),
      cost_price INTEGER CHECK (cost_price >= 0),
      mrp INTEGER CHECK (mrp >= 0),
      source TEXT NOT NULL CHECK (source IN ('opening', 'purchase', 'adjustment')),${timestamps}
    ) STRICT`,
    `CREATE INDEX batch_product_idx ON batch (product_id, expiry_date)`,

    `CREATE TABLE stock_movement (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL REFERENCES branch (id),
      device_id TEXT NOT NULL REFERENCES device (id),
      product_id TEXT NOT NULL REFERENCES product (id),
      batch_id TEXT NOT NULL REFERENCES batch (id),
      qty INTEGER NOT NULL CHECK (qty <> 0),
      kind TEXT NOT NULL CHECK (kind IN (
        'opening', 'receive', 'sale', 'sale_return', 'supplier_return',
        'adjustment', 'count', 'expiry_writeoff', 'transfer_in', 'transfer_out'
      )),
      ref_type TEXT,
      ref_id TEXT,
      reason TEXT,
      user_id TEXT REFERENCES app_user (id),
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX stock_movement_batch_idx ON stock_movement (batch_id)`,
    `CREATE INDEX stock_movement_product_idx ON stock_movement (product_id, created_at)`,
    `CREATE INDEX stock_movement_ref_idx ON stock_movement (ref_type, ref_id)`,
    ...appendOnly('stock_movement'),

    `CREATE TABLE batch_stock (
      branch_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      qty INTEGER NOT NULL,
      PRIMARY KEY (branch_id, batch_id)
    ) STRICT, WITHOUT ROWID`,
    `CREATE INDEX batch_stock_product_idx ON batch_stock (product_id)`,

    // Keeps batch_stock in step with the ledger, whichever code path inserts a movement.
    `CREATE TRIGGER stock_movement_to_batch_stock AFTER INSERT ON stock_movement
     BEGIN
       INSERT INTO batch_stock (branch_id, batch_id, product_id, qty)
       VALUES (NEW.branch_id, NEW.batch_id, NEW.product_id, NEW.qty)
       ON CONFLICT (branch_id, batch_id) DO UPDATE SET qty = qty + excluded.qty;
     END`,

    // ---- Audit ----
    `CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      branch_id TEXT REFERENCES branch (id),
      device_id TEXT REFERENCES device (id),
      user_id TEXT REFERENCES app_user (id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id)`,
    `CREATE INDEX audit_log_created_idx ON audit_log (created_at)`,
    ...appendOnly('audit_log'),
  ],
};
