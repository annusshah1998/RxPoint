# 0007: PIN login, permissions and scoped approvals

**Status:** accepted (M2)

## Context

One till is shared by the owner, pharmacists and cashiers, often within a shift. Cashiers
may sell but not void, give large discounts or dispense controlled drugs; a pharmacist
standing next to them can allow it. Staff won't type passwords at a counter, the till
works offline, and the screen alone can't be trusted to enforce anything. An approval must
cover what the approver saw, not whatever the cart becomes afterwards.

## Decision

- **Login:** pick your name, type your PIN. PINs are PBKDF2 hashes (120,000 iterations;
  `ctx.pinIterations`, 1,000 in tests), checked outside any transaction. The owner's PIN
  has 6 digits and comes with a one-time recovery code; others have at least 4, and weak
  PINs (one digit repeated, a run) are refused. Wrong PINs lock that user for 1 minute after
  5 failures, 5 minutes after 10 and 15 minutes after 15 (`pin_attempt`, local). Ctrl+L or
  5 idle minutes lock the till and keep the cart.
- **Roles and permissions** live in one table in `packages/core/src/permissions.ts`
  (owner, pharmacist, cashier, inventory), with a snapshot test. Services call
  `authorizeTx` first inside their transaction, reading the user's role and `is_active`
  fresh, so a role change or switch-off applies at once. The UI only hides buttons.
- **FORBIDDEN or NEEDS_APPROVAL:** a missing permission is `FORBIDDEN` unless it is marked
  approvable (void, return, late return, controlled, no-sale, large pay-out, clock reset,
  and price override for later). Then the service answers `NEEDS_APPROVAL` and a qualifying
  user types their PIN. A discount above the seller's cap is the approval kind
  `sale.discount`; whoever's own cap covers the need may approve it.
- **Approvals for one action** (void, return, pay-out, no-sale, clock reset) travel with
  that call and are used once. `verifyApprover` refuses self-approval, and a wrong PIN counts
  against the approver, not the cashier. The approver is re-read inside the transaction.
- **Approvals on the sale in progress are scoped.** A discount over the cap or dispensing
  controlled drugs is stored in `draft_approval` (local) with `scope_json`: exactly what was
  approved (the line's product, quantity, price and discount and the bill discount; for
  controlled lines the batches and the prescription), `approved_bp` (the need computed by the
  service from the saved draft, never the approver's whole cap and never a number from the
  screen) and `requested_by` (who was selling). `grantCovers` accepts it only while the cart
  still matches and the same person completes the sale. Holding the sale deletes its
  approvals, and a login deletes approvals asked for by anyone else.

## Alternatives considered

- **Passwords or cards:** slower at a counter; cards get shared just like PINs.
- **Checks in the UI only:** any bug or future screen bypasses them.
- **An approval as a role "unlock" for a time window:** the approver can't know what will
  be sold under it.
- **Unscoped grants** (the first working tree: limit = the approver's cap, any line, never
  expiring, need sent by the client): one 15% approval would have covered every line and any
  later change.

## Consequences

- Every sensitive action is audited with `approved_by`, and the controlled-drug register
  gets the real dispenser: the seller if they hold `sale.controlled`, otherwise the approver.
- An approval that no longer matches is simply not counted: the need comes back and Pay
  asks for a PIN again. A bill-discount approval is invalidated by any line change.
- Anyone who copies `till.db` can brute-force 4–6-digit PINs offline. The lockout protects
  the till itself; file and backup encryption is a decision for M6.
- **Differences from the design:**
  - The scoped `draft_approval` was planned as a rebuild in migration
    `0003-scoped-approvals`. Migration 0002 had not shipped, so the table got its scoped
    shape there and no 0003 was needed for it (0003 became the backup mirror, ADR 0009).
  - Discount and controlled-drug approvals are asked for at Pay, after the flush, one need
    at a time ("Your limit is 5%; more needs a pharmacist's PIN at Pay"), not as soon as the
    discount is typed, and there is no "Approval no longer covers this" chip on the line.
  - `sale.price_override` exists in the schema and the permission table, but nothing
    grants it until price override returns.
