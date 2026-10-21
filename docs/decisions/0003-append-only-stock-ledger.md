# 0003: Append-only stock ledger with batch lots

**Status:** accepted (M1)

## Decision

- Every stock change is a row in `stock_movement` (opening, receive, sale, return,
  adjustment, count, expiry write-off, transfer) with a signed quantity in base units.
  Triggers reject UPDATE and DELETE.
- Stock on hand per batch is the sum of its movements. `batch_stock` caches it, kept up
  to date by an `AFTER INSERT` trigger, and can be rebuilt and checked against the ledger.
- A `batch` row is one received lot. The same printed batch number may appear in several
  rows (received twice at different costs).
- Selling past zero is allowed (with a warning in checkout, M2): stock data is rarely
  accurate at go-live and sales must not stop. Adjustments cannot take a batch below zero.

## Why

- A full history answers "where did this stock go?" and supports controlled-drug audits.
- Inserts never conflict, which keeps multi-till and cloud sync (M6) simple.
- The trigger keeps the cache right whichever code path writes a movement, including
  sync.
