# 0004: Sync-ready from day one

**Status:** accepted (M1); sync itself is built in M6

## Decision

- UUIDv7 ids created on the till.
- Every synced table has `created_at` and `updated_at`; branch-scoped rows carry
  `branch_id`; movements and audit rows carry `device_id`.
- Every insert or update of a synced table also writes a `sync_outbox` row with the full
  new row, in the same transaction (`insertRow` / `updateRow` in `packages/db/src/writes.ts`).
- Tables are classed in `SYNCED_TABLES` as `append` (never change) or `mutable` (newest
  change wins).
- Synced rows are never deleted, only deactivated.

## Why

Retrofitting change tracking after data exists in pharmacies is painful and error-prone.
Writing the outbox now costs one extra insert per change and lets M6 focus on transport
and conflict rules.

## Open questions for M6

- Clock skew between tills (use server time on upload; warn when a till's clock is off).
- Merging duplicate names (manufacturer, generic) created offline on two tills.
- Pull cursor design on the server.
