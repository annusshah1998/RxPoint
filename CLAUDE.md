# Project guide

Offline-first point of sale and inventory for pharmacies. First market: Punjab, Pakistan.
Single store and one till for the pilot; multi-branch later. Built by one developer,
part-time. Plan and status: `docs/plan.md`. How it fits together: `docs/architecture.md`.
Compliance findings (unconfirmed): `docs/compliance-pk.md`.

"RxPoint" is a working name that will change.

## Hard rules

- **Never mention Claude, and never add "Co-Authored-By" (or any AI attribution) lines,
  in commit messages, PR titles or PR descriptions.**
- **Product name**: only in `packages/config/product.json` (copied into
  `apps/till/src-tauri/tauri.conf.json` by `pnpm sync:name`). Code reads it from
  `PRODUCT` in `@app/config`. `pnpm check:name` fails on any other use in code.
  Package names use the neutral `@app/*` scope; the app id is `com.pharmacypos.till`.
- **Money** is a whole number of paisa (`Money`). Never floats, never rupees in storage.
  Parse with `parseMoney`, show with `formatMoney`, split with `priceForQty` / `divRound`.
- **Quantities** are whole base units (tablets). Pack sizes are conversions on top.
- **Prices** are stored per pack as printed (`amount` for `perQty` base units) and
  rounded once per line.
- **Stock** changes only by inserting `stock_movement` rows. Never update `batch_stock`
  directly (a trigger maintains it). Never update or delete movements or audit rows.
- **Synced tables** are written only through `insertRow` / `updateRow`
  (`packages/db/src/writes.ts`) inside the caller's transaction, so `sync_outbox` stays
  complete. Never hard-delete a synced row; set `is_active = 0`.
- **Sensitive changes** (prices, stock edits, voids, discounts) call `audit()` in the same
  transaction.
- **Ids** from `ctx.newId()` (UUIDv7); time from `ctx.now()`; "today" from `today(ctx)`
  (store time zone, Asia/Karachi), never UTC dates.
- **Schema**: add a new migration in `packages/db/src/migrations/` and update
  `schema.ts`; never edit a migration that has shipped. Use STRICT tables.
- **UI text** goes in `apps/till/src/strings.ts`.
- **Dependencies**: pin exact versions; pnpm refuses releases younger than 7 days
  (`minimumReleaseAge`). Don't work around it.

## Layout

```
apps/till/src/app/          Boot, shell, router, services context
apps/till/src/features/     One folder per screen area (products, stock, import, setup)
apps/till/src/ui/           Shared components (Field, Button, Card, Modal …)
apps/till/src/platform/     SqlExecutor for desktop (Tauri) and browser preview (WASM)
apps/till/src-tauri/        Rust shell: db.rs (SQLite bridge), lib.rs (commands)
apps/till/e2e/              Playwright tests (browser preview)
packages/core/src/          Pure rules: money, units, pricing, dates, fefo, qty-input, ids
packages/db/src/            executor, migrations, schema, writes, services/*
```

## Commands

```sh
pnpm install
pnpm check                 # name check, prettier, eslint, tsc, vitest — run before committing
pnpm test                  # unit tests only
pnpm test:e2e              # Playwright; locally may need CHROMIUM_PATH=/path/to/chromium
pnpm dev                   # browser preview on :1420
pnpm tauri dev             # desktop app
cd apps/till/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

## Writing a service

Services live in `packages/db/src/services/`, take `ctx: AppContext` (or
`ServiceContext` before setup), validate input with zod via `parseInput`, and do all
writes in one `ctx.db.transaction()`. Throw `AppError` with a message staff can read and
`fields` keyed by form path (`units.1.qty`). Helpers that run inside a caller's
transaction end in `Tx` and take `trx` first (e.g. `insertProductTx`).

Test services against a real in-memory database with `createTestApp()` from
`packages/db/src/test-helpers.ts` (fixed clock: 21 Oct 2026, Karachi).

## Writing a screen

Load data with `useQuery` and the services; write with `useAction` (it refreshes all
queries). Show `errorMessage(error)` and `fieldErrors(error)` from `src/lib/errors.ts`.
Use `Field` + `TextInput`/`Select` so labels and hints are wired for screen readers and
Playwright `getByLabel`. Keep it keyboard-friendly: scanners type fast and press Enter.

## Domain notes (Pakistan)

- Distributor invoices: trade price (TP), discount %, bonus quantity ("10+1"). Bonus
  units lower batch cost.
- MRP is printed per batch and changes over time; never sell above a batch's MRP without
  a warning.
- Controlled drugs (Punjab Drugs Rules 2007, Schedules B and D) need a prescription and a
  register entry.
- Payments: cash, card, JazzCash / Easypaisa / Raast (wallet with reference), khata.
- Load-shedding is common: committed data must survive power cuts (SQLite WAL +
  `synchronous = FULL`).
- Sales must never stop: selling past zero stock warns, it doesn't block. Expired
  batches are blocked.

## Status

M1 (foundations, catalog, stock, import) is done. M2a, a full day of sales on one till, is
done (see `docs/plan.md` and the build order in `docs/m2-design.md`): login, roles and
approvals, shifts, the Sale screen (the home route), batch picker, discounts,
controlled-drug capture, split payments, hold/resume, void, returns, receipt preview,
backups, the clock guard, the scan detector and the keyboard shortcuts with F1 help are
built, and `e2e/full-day.spec.ts` checks a day's shift report against its own sums. Left
for M2b: real printing and the cash drawer, WebView2 keys, the backup mirror folder and the
ADRs. No printer or scanner is needed to run or test the till.
