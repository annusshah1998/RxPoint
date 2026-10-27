# 0005: Checkout records and signed payments

**Status:** accepted (M2)

## Context

A sale touches stock, money and, for controlled drugs, a legal register. Staff void sales,
take items back days later and refund by a different method. The till must answer "what
should be in the drawer?" and "where did this strip go?" from its own records, and in M6
the same rows are replayed on other tills and the server (ADR 0003, ADR 0004). Updating a
row in place (a "voided" flag, a running refund total) loses history and conflicts when two
copies change it.

## Decision

- **A sale never changes.** `sale`, `sale_line`, `sale_line_batch` and `sale_prescription`
  are append-only (triggers reject UPDATE and DELETE). `sale_line_batch` freezes what each
  line took: batch no., expiry, cost, MRP and stock before, plus the `stock_movement` it
  wrote. Every amount is a whole number of paisa with CHECKs that tie them together
  (`subtotal = gross − discounts`, `total = subtotal + rounding`).
- **One signed money ledger.** Every rupee in or out is a `payment` row with a `doc_type`:
  `sale` (always positive), `void` or `return` (negative). Each row belongs to the shift
  whose drawer it touched and carries its method (cash, card, wallet with provider and a
  reference of at least 4 characters, khata). Cash rows record tendered and change.
- **A void** is a `sale_void` row plus a reversing movement for each allocation and a
  negative payment for each original payment, in one transaction. Only a sale from the open
  shift with no returns can be voided; after that it is a return.
- **A return** is a `sale_return` with one `sale_return_line` per returned piece of an
  allocation, a movement only when the item goes back on the shelf (never for an expired
  batch), and negative payments. Refunds use cumulative rounding, so all returns of a sale
  add up exactly to its total. Card and wallet refunds are capped at what was paid that way;
  cash is limited to what is in the drawer.
- **Expected cash** = opening float + Σ cash `payment.amount` + Σ `cash_movement.amount`
  for the shift. A sale with a total of 0 has no payment rows.
- **Selling past zero** takes the shortfall from the product's placeholder "Unrecorded
  stock" batch, so real batches are never driven negative by a guess. A controlled drug
  never uses the placeholder: its batch is picked, or typed from the pack as a real batch.
- **Invoice numbers** are per till (`T1-000123`, returns `T1-R000012`), taken inside the
  completing transaction as `max(highest + 1, floor)`, so there are no gaps (floors:
  ADR 0009).
- **Triggers only for rules that hold in any replay order:** append-only tables, a closed
  shift is final, no expired batch on a sale, no over-return, no void after a return, a void
  only from the sale's own shift. Rules that depend on order ("only into an open shift",
  "a cash refund no larger than the drawer", "an allocation matches its movement") stay in
  the services, and `checkRecords` (`packages/db/src/services/integrity.ts`) verifies them.

## Alternatives considered

- **Status and refund columns on `sale`** (`voided`, `refunded_total`): simple to query,
  but they change in place, lose who did what and when, and conflict in M6 sync.
- **Payment columns on the sale** (`cash`, `card`, `wallet`): can't express split payments,
  several wallets or refunds by a different method.
- **Expected cash from sale totals:** wrong as soon as a sale is split between card and
  cash, or a return is refunded in cash from a later shift.
- **Negative stock on real batches:** keeps one fewer row, but the controlled register and
  recalls would point at a batch the pack never came from.

## Consequences

- Every figure on the shift report is a sum of inserts; nothing has to be kept in step.
  `e2e/full-day.spec.ts` and `integrity.test.ts` check a whole day against those sums.
- Reports must always read a sale together with its void and returns.
- `payment.sale_id` is NOT NULL and `doc_type` is limited to sale, void and return, so khata
  collections need their own table (ADR 0011).
- Profit on unrecorded stock uses the product's usual cost until M3's counts settle the
  placeholder. In M6 the placeholder (one per product) and batches typed from packs will
  need merging across tills.
- Built as designed (`docs/m2-design.md` D4, D6, D11, D13): migration `0002-checkout`,
  `services/checkout.ts`, `sale-build.ts`, `sales.ts` (void) and `returns.ts`.
