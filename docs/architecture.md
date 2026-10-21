# Architecture

```
┌──────────── Pharmacy PC (Windows 10/11) ───────────┐          ┌──── Cloud (M6+) ────────┐
│ Till app (Tauri 2)                                  │   sync   │ API + PostgreSQL        │
│   React screens + all business logic (TypeScript)   │ ◄──────► │ sync, backups, reports  │
│   Thin Rust layer: SQLite, printer, cash drawer     │  when    │ Owner dashboard (web)   │
│   Barcode scanner works as a keyboard               │  online  └─────────────────────────┘
└─────────────────────────────────────────────────────┘
```

## Packages

| Path              | What it is                                                                                           | Depends on       |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| `packages/config` | Product name, market defaults (PKR, Asia/Karachi), inventory defaults                                | —                |
| `packages/core`   | Pure business rules: money, units, pricing, dates/expiry, FEFO, quantity input, ids, errors. No I/O. | config           |
| `packages/db`     | SQLite schema and migrations, the Kysely driver, and the services that read and write data           | core, config     |
| `apps/till`       | React UI, platform adapters (desktop / browser), Tauri shell in `src-tauri/`                         | db, core, config |

Planned: `packages/receipt` (ESC/POS builder, M2), `packages/sync` (M6), `apps/cloud` (M6),
`apps/dashboard` (M7).

## How a query reaches the database

```
React screen ──► service (packages/db/src/services) ──► Kysely ──► SqlExecutor
                                                                    ├─ desktop: Tauri IPC → Rust (rusqlite)
                                                                    ├─ browser preview: SQLite WebAssembly
                                                                    └─ unit tests: node:sqlite
```

- `SqlExecutor` (`packages/db/src/executor.ts`) runs **one statement** on **one
  connection**. Each platform implements it in a few lines.
- The Kysely driver holds a lock from `BEGIN` to `COMMIT`, so no other query can slip
  into a transaction while it waits on IPC. This is why the official `tauri-plugin-sql`
  isn't used: it has no transaction API.
- The Rust side (`apps/till/src-tauri/src/db.rs`) opens the file with WAL and
  `synchronous = FULL` (committed sales survive power cuts), and converts JSON values to
  SQLite values. It has no business logic. You don't need to know Rust to work on the app.
- On start the app calls `reset` (rolls back a transaction a crashed page left open), then
  runs migrations.

## Data rules

- **Ids**: UUIDv7 text, made on the till (`ctx.newId()`), so offline tills never clash.
- **Money**: whole paisa (`Money = number`, integer). Prices are stored per pack as
  printed (`sale_price` for `price_qty` base units). A line's price is computed once:
  `round(packPrice × qty ÷ packQty)`.
- **Quantities**: whole base units (tablets). Units (Strip = 10, Box = 30) are conversions
  on top.
- **Stock**: `stock_movement` is an append-only ledger (triggers reject UPDATE/DELETE).
  Stock on hand = sum of movements per batch. `batch_stock` is a cache kept by an
  `AFTER INSERT` trigger and can be rebuilt (`rebuildStockCache`).
- **Batches**: one `batch` row per received lot (product, batch no., expiry, cost, MRP).
  The same printed batch number can appear in several rows.
- **Dates**: timestamps are ISO UTC text; calendar dates are `YYYY-MM-DD`. "Today" is the
  date in the store's time zone (`today(ctx)`), never UTC.
- **STRICT tables**: SQLite rejects a fraction in an INTEGER column, so float money
  can't sneak in.

## Sync-ready from day one (sync itself is M6)

- Every write to a synced table goes through `insertRow` / `updateRow`
  (`packages/db/src/writes.ts`), which also adds a row to `sync_outbox` in the same
  transaction.
- `SYNCED_TABLES` marks each table `append` (ledger-like: never conflicts) or `mutable`
  (newest change wins; history is in the audit log).
- Synced rows are never deleted; they are deactivated (`is_active = 0`).
- Local-only tables: `local_meta`, `sync_outbox`, `batch_stock`, `product_fts`,
  `schema_migration`.
- Known M6 issue: unique names (manufacturer, generic) created on two offline tills will
  need merging on the server.

## Search

`product_fts` is an FTS5 table with the trigram tokenizer over brand, salts, strengths,
form and manufacturer. Words of 3+ characters match anywhere in the text; shorter words
fall back to a substring match. Exact and starts-with brand matches rank first. A scanned
barcode is matched exactly first. Bulk imports rebuild the index once at the end.

## Services pattern

```ts
export async function doThing(ctx: AppContext, input: ThingInput) {
  const data = parseInput(thingSchema, input);       // zod; errors become AppError('VALIDATION')
  return ctx.db.transaction().execute(async (trx) => {
    await insertRow(trx, timestamp(ctx), 'table', {...}); // queues sync
    await audit(trx, ctx, {...});                       // for sensitive changes
  });
}
```

`AppError` messages are written for staff and shown as-is; `fields` maps form paths
(e.g. `units.1.qty`) to messages. Any other error is treated as a bug.

## UI

- Screens live in `apps/till/src/features/<feature>/`. Shared pieces in `src/ui/`.
- Data loading uses TanStack Query; every write goes through `useAction`, which
  refreshes all cached queries afterwards (the database is local and fast).
- Navigation is a small hash router (`src/app/router.ts`).
- All text is in `src/strings.ts`.

## Testing

| Layer                | Tool                             | Where                           |
| -------------------- | -------------------------------- | ------------------------------- |
| Core rules           | Vitest                           | `packages/core/src/*.test.ts`   |
| Services and schema  | Vitest + node:sqlite (in memory) | `packages/db/src/**/*.test.ts`  |
| UI logic             | Vitest                           | `apps/till/src/**/*.test.ts`    |
| Rust database bridge | `cargo test`                     | `apps/till/src-tauri/src/db.rs` |
| Whole app            | Playwright, browser preview      | `apps/till/e2e/`                |
