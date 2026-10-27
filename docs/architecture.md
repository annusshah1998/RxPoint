# Architecture

```
┌──────────── Pharmacy PC (Windows 10/11) ───────────┐          ┌──── Cloud (M6+) ────────┐
│ Till app (Tauri 2)                                  │   sync   │ API + PostgreSQL        │
│   React screens + all business logic (TypeScript)   │ ◄──────► │ sync, backups, reports  │
│   Thin Rust layer: SQLite, printer, cash drawer     │  when    │ Owner dashboard (web)   │
│   Barcode scanner works as a keyboard               │  online  └─────────────────────────┘
└─────────────────────────────────────────────────────┘
```

Why it is built this way: the decision records in `docs/decisions/` (0001–0011; 0012, the
store network, is planned in `docs/counters-design.md`). The M2 design and its as-built
notes are in `docs/m2-design.md`.

## Packages

| Path               | What it is                                                                                                                                                   | Depends on                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `packages/config`  | Product name, market defaults (PKR, Asia/Karachi), inventory and checkout defaults                                                                           | —                         |
| `packages/core`    | Pure business rules: money, units, pricing, dates/expiry, FEFO, quantity input, ids, errors; checkout, tenders, cart, permissions, PINs, clock, backup rules | config                    |
| `packages/db`      | SQLite schema and migrations, the Kysely driver, and the services that read and write data                                                                   | core, config              |
| `packages/receipt` | Receipt document: the 48/42/32-column text preview and the ESC/POS bytes from the same document                                                              | —                         |
| `apps/till`        | React UI, receipt templates, platform adapters (desktop / browser), Tauri shell in `src-tauri/`                                                              | db, core, config, receipt |

Planned: `packages/sync` (M6), `apps/cloud` (M6), `apps/dashboard` (M7).

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
  into a transaction while it waits on IPC. Transactions start with `BEGIN IMMEDIATE`, so
  they take the write lock up front instead of failing halfway. This is why the official
  `tauri-plugin-sql` isn't used: it has no transaction API.
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
  The same printed batch number can appear in several rows. Each product may have one
  placeholder "Unrecorded stock" batch that takes sales past zero (ADR 0005).
- **Sales and money** (M2, ADR 0005): sales, voids, returns and payments are append-only.
  `payment` is one signed ledger (`sale` +, `void` and `return` −), and expected cash is the
  float plus cash payments plus cash in/out for the shift.
- **Document numbers**: per till (`T1-000123`, returns `T1-R000012`), taken inside the
  writing transaction as `max(highest + 1, floor)`, so there are no gaps.
- **Dates**: timestamps are ISO UTC text; calendar dates are `YYYY-MM-DD`. "Today" is the
  date in the store's time zone (`today(ctx)`), never UTC. Expiry checks use the later of
  today and the date of the last record (ADR 0010).
- **STRICT tables**: SQLite rejects a fraction in an INTEGER column, so float money
  can't sneak in.
- **Triggers** enforce only rules that hold in any replay order of valid history; rules
  that depend on order stay in the services and `checkRecords` verifies them.

## Sync-ready from day one (sync itself is M6)

- Every write to a synced table goes through `insertRow` / `updateRow`
  (`packages/db/src/writes.ts`), which also adds a row to `sync_outbox` in the same
  transaction.
- `SYNCED_TABLES` marks each table `append` (ledger-like: never conflicts) or `mutable`
  (newest change wins; history is in the audit log).
- Synced rows are never deleted; they are deactivated (`is_active = 0`).
- Local-only tables: `local_meta`, `sync_outbox`, `batch_stock`, `product_fts`,
  `schema_migration`, and from M2 `sale_draft`, `draft_approval`, `pin_attempt` and
  `backup_log`. Held sales and their approvals never leave the till.
- Known M6 issues: unique names (manufacturer, generic) created on two offline tills, and
  placeholder or hand-typed batches, will need merging on the server.

## Search

`product_fts` is an FTS5 table with the trigram tokenizer over brand, salts, strengths,
form and manufacturer. Words of 3+ characters match anywhere in the text; shorter words
fall back to a substring match. Exact and starts-with brand matches rank first. A scanned
barcode is matched exactly first. Bulk imports rebuild the index once at the end.

## Services pattern

```ts
export async function doThing(ctx: AppContext, input: ThingInput) {
  const data = parseInput(thingSchema, input);          // zod; errors become AppError('VALIDATION')
  const approval = await resolveApproval(ctx, input.approval, 'sale.void'); // PIN check, outside
  return ctx.db.transaction().execute(async (trx) => {
    const { approvedBy } = await authorizeTx(trx, ctx, 'sale.void', approval); // first
    await insertRow(trx, timestamp(ctx), 'table', {...}); // queues sync
    await audit(trx, ctx, { ..., approvedBy });           // for sensitive changes
  });
}
```

- PIN and other slow checks run **before** the transaction; nothing awaits crypto, Rust or
  a printer inside one.
- `authorizeTx` reads the user's role fresh. A missing permission is `FORBIDDEN`, or
  `NEEDS_APPROVAL` when another user's PIN may allow it (ADR 0007).
- `AppError` messages are written for staff and shown as-is; `fields` maps form paths
  (e.g. `units.1.qty`) to messages. Any other error is treated as a bug.

## Checkout (M2)

| Area                                 | Where                                                                    | Decision |
| ------------------------------------ | ------------------------------------------------------------------------ | -------- |
| Sales, voids, returns, payments      | `services/checkout.ts`, `sale-build.ts`, `sales.ts`, `returns.ts`        | ADR 0005 |
| The open sale (drafts), hold, resume | `services/drafts.ts`, `features/sale/use-sale.ts`                        | ADR 0006 |
| Login, roles, approvals              | `services/auth.ts`, `users.ts`, `guards.ts`; `core/permissions.ts`       | ADR 0007 |
| Shifts, cash in/out, blind close     | `services/shift.ts`                                                      | ADR 0005 |
| Receipts, printing, the drawer       | `packages/receipt`, `features/receipt`, `features/printing`, `platform/` | ADR 0008 |
| Backups and the backup drive         | `services/backup.ts`, `platform/backup-port.ts`, `src-tauri/backup.rs`   | ADR 0009 |
| Clock guard                          | `core/clock.ts`, `services/clock.ts`, `guards.ts`, `features/clock/`     | ADR 0010 |
| Record checks                        | `services/integrity.ts` (`checkRecords`; a Health screen comes in M5)    | ADR 0005 |
| Khata                                | Refused until M4 (customers)                                             | ADR 0011 |

## Desktop shell (`apps/till/src-tauri/src`)

| File         | Commands and job                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `db.rs`      | `db_execute`, `db_reset`; the SQLite file; `restore_from` behind `backup_restore`                                                               |
| `backup.rs`  | `backup_create`, `backup_verify`, `backup_list`, `backup_delete`, `backup_copy`, `folder_check`: `VACUUM INTO` on a second read-only connection |
| `printer.rs` | `print_raw` (RAW Windows spooler job, or TCP port 9100), `printer_list`                                                                         |
| `webview.rs` | Turns off WebView2's browser keys (F5, Ctrl+R, Ctrl+P, Ctrl+F, zoom, back) at start-up, Windows only                                            |
| `lib.rs`     | `app_info` and the command list                                                                                                                 |

The TypeScript side wraps these in `apps/till/src/platform/` (`tauri-executor.ts`,
`backup-port.ts`, `printer.ts`). In the browser preview there are no backups, and Network
printing goes through the Vite dev server (`apps/till/dev-printer-bridge.ts`, development
only).

## UI

- Screens live in `apps/till/src/features/<feature>/`. Shared pieces in `src/ui/`.
- Data loading uses TanStack Query; every write goes through `useAction`, which
  refreshes all cached queries afterwards (the database is local and fast). Draft saves and
  `planSale` are the exceptions: debounced, outside `useAction`.
- `Services` (`src/app/services.tsx`) carries the context, the store, the platform, `lock`,
  the backup port (null in the browser) and the printer.
- Navigation is a small hash router (`src/app/router.ts`); the Sale screen is the home
  route. `src/app/keys.ts` guards browser keys in the page; F1 lists every shortcut.
- All text is in `src/strings.ts`.

## Testing

| Layer               | Tool                             | Where                                                    |
| ------------------- | -------------------------------- | -------------------------------------------------------- |
| Core rules          | Vitest                           | `packages/core/src/*.test.ts`                            |
| Services and schema | Vitest + node:sqlite (in memory) | `packages/db/src/**/*.test.ts`                           |
| Receipts            | Vitest (golden text and bytes)   | `packages/receipt/src/*.test.ts`, `features/receipt/`    |
| UI logic            | Vitest                           | `apps/till/src/**/*.test.ts`                             |
| Fake printer        | Vitest                           | `scripts/*.test.ts`                                      |
| Rust shell          | `cargo test` (Linux and Windows) | `apps/till/src-tauri/src/*.rs`                           |
| Whole app           | Playwright, browser preview      | `apps/till/e2e/` (`full-day.spec.ts` checks a whole day) |
