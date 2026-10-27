# 0006: Drafts and idempotent completion

**Status:** accepted (M2)

## Context

Load-shedding cuts power mid-sale, staff press F5 or Enter twice, and a cashier may hold a
customer's basket while serving the next one. A cart kept only in screen memory is lost on
a reload; a cart saved by an upsert can come back after it was completed or discarded; and
a double Enter must not record the sale twice. Approvals also need a saved row to belong to
(ADR 0007).

## Decision

- **The cart lives in a local `sale_draft` row** (not synced): `active` (one per till,
  enforced by a partial unique index) or `held`. `startDraft` creates it when a cart starts,
  so it exists before any approval.
- **Saves only UPDATE.** The screen saves `cart_json`, `line_count`, `total` and
  `updated_at` 150 ms after the last change, in one statement that never inserts and never
  writes `status`. A save that changes 0 rows means the draft was completed or discarded,
  and the screen ignores it.
- **Flush before every state change.** `flush()` (`features/sale/use-sale.ts`) cancels the
  timer and awaits one save before Pay completes, hold, resume, discard, an approval and
  lock.
- **Completion reads the saved cart.** `completeSale` takes the draft id, the tenders and
  the total the screen showed. It reads the cart from the draft row, and the sale gets the
  draft's id. In one `BEGIN IMMEDIATE` transaction it first returns an existing sale with
  that id (`alreadyCompleted: true`), then re-prices and re-checks everything, refuses with
  `TOTAL_CHANGED` if the total differs from what the cashier saw, writes the records and
  deletes the draft (its approvals cascade).
- **Hold and resume** swap `status` in one transaction: resuming holds the current cart if
  it has lines, at most `maxHeld` (10) are held, and holding deletes the draft's approvals.
  Discarding a cart with lines is audited.
- **A cart from another version** (`version` is not 1) is set aside as held with a notice,
  never thrown away.

## Alternatives considered

- **Cart in memory or `localStorage` only:** lost on a crash or reload, and invisible to
  the services that check approvals.
- **`INSERT … WHERE NOT EXISTS (sale) … ON CONFLICT DO UPDATE`** for saves (proposed in the
  design review): still brings back a _discarded_ draft and still needs the row before an
  approval can point at it.
- **A separate idempotency key** sent with Pay: one more value to keep in step; the draft
  id already identifies the sale.
- **Saving on every keystroke:** each save is an fsync, 10–30 ms on an HDD; scanners type
  faster than that.

## Consequences

- A crash, reload or power cut loses at most the last 150 ms of typing; `sale.spec`
  reloads mid-cart and gets the lines back. Completing twice returns the same sale, and a
  test with a temporary failing trigger shows a failed completion leaves every table, the
  outbox and the draft as they were.
- The sale id is a UUIDv7 made when the cart started, so id order is not invoice order;
  sort by `invoice_seq` or `created_at`.
- Held sales and their approvals stay on the till that held them; M6 does not sync them.
- Built as designed (`docs/m2-design.md` D8, §4.5, §4.6): `services/drafts.ts`,
  `services/checkout.ts`.
