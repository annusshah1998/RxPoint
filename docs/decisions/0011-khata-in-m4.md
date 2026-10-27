# 0011: Khata in M4

**Status:** accepted (M2); built in M4

## Context

Khata (a customer's running tab) is common in Pakistani pharmacies: regulars take medicine
on credit and settle weekly or monthly, often in cash at the counter. Credit only makes
sense with a customer ledger, limits, statements and a way to record collections, which
belong to M4 (customers). The pilot starts after M5, so khata exists before any real store
depends on the till. M2's records must leave room for it without a rebuild.

## Decision

- **M2 refuses khata.** `settleTenders` returns `khata_unavailable`, `completeSale` answers
  `NOT_AVAILABLE` ("Khata comes with customer accounts") and the Pay dialog greys the
  tender out. The `payment.method` CHECK already allows `'khata'`, so no table rebuild is
  needed later.
- **Credit sales in M4** are ordinary sales with a `payment` row whose method is `khata`.
  M4 adds a `customer` table and a nullable `payment.customer_id`
  (`ALTER TABLE payment ADD COLUMN customer_id TEXT REFERENCES customer (id)`), which SQLite
  allows because the default is NULL. A void or a return refunded to khata is a negative
  khata payment, so a customer's balance is a sum, like everything else (ADR 0005).
- **Collections get their own append-only, synced table, `khata_payment`**: the customer,
  the shift and till, the method (cash, card or wallet, with a reference), a positive amount,
  who took it and when. They fit neither existing cash table: `payment.sale_id` is NOT NULL
  and `doc_type` is limited to sale, void and return; `cash_movement` has no customer and
  its categories are for expenses and the owner.
- **Expected cash becomes** opening float + Σ cash `payment.amount` + Σ
  `cash_movement.amount` + Σ cash `khata_payment.amount` for the shift. M4 changes
  `expectedCash` (core) and `expectedCashTx`, adds a "Khata collected" row to
  `getShiftTotals`, teaches `checkRecords` the new table, and updates this ADR.

## Alternatives considered

- **A minimal khata in M2** (a name typed on the payment): a receivable no one can chase,
  with no limits or statements, rebuilt in M4 anyway.
- **Collections as `payment` rows:** would need a nullable `sale_id` and a new `doc_type`;
  SQLite can't change a CHECK without rebuilding an append-only, synced table.
- **Collections as a `cash_movement` category:** no customer link, and card or wallet
  collections don't move the drawer at all.
- **Collections as negative sales:** distorts sales, discounts and tax totals.

## Consequences

- Until M4 a store that gives credit keeps its paper khata; nothing in M2 has to be
  migrated.
- Expected cash is computed in one place, `expectedCashTx`, which the pay-out and
  cash-refund limits, the shift close and `checkRecords` all use; M4 changes it there and
  extends the full-day tests with a collection.
- No schema change in M2 (`docs/m2-design.md` D5, review note 16). The `khata_payment`
  columns above are the intended shape, to be settled in the M4 design.
