# MVP plan

RxPoint is a working name (it is already used by real pharmacies and a consulting firm).
It lives only in `packages/config/product.json`; rename before public launch.

## Decisions so far

| Question        | Decision                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------- |
| First market    | Pakistan, Punjab                                                                                    |
| Branches        | Single store first; every record carries a branch id so multi-branch is an add-on                   |
| Tills per store | One till for the pilot; a second till needs sync (M6)                                               |
| Platform        | Desktop till (Tauri 2, Windows 10/11) plus a web dashboard later                                    |
| Team and pace   | One developer, part-time (~10–12 h/week)                                                            |
| Pilot           | After M5, without cloud sync, with automatic local backups                                          |
| Stack           | TypeScript everywhere; a thin Rust layer for SQLite and hardware; PostgreSQL in the cloud (M6)      |
| Above-MRP sales | Warn, don't block                                                                                   |
| Test hardware   | None yet: printing is off by default with an on-screen receipt preview; typed barcodes act as scans |

Hardware assumed for the pilot: 80mm ESC/POS thermal printer, USB barcode scanner in keyboard
mode, cash drawer opened through the printer. None is available for testing yet, so every
feature must work and be testable without it.

## Milestones

Estimates are rough, at 10–12 hours a week.

| #   | Milestone                         | Scope                                                                                                                                                                                                                                                                                     | Done when                                                                                                              | Est.  | Status   |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----- | -------- |
| M1  | Foundations, catalog, stock       | Repo setup, CI, config, core rules (money, units, pricing, FEFO), SQLite schema and migrations, stock ledger, sync outbox, Tauri app with the Rust database bridge, catalog screens and search, CSV import, opening stock by batch                                                        | A catalog CSV can be imported, current stock entered by batch and expiry, and any item found by brand, generic or salt | 3 wks | **Done** |
| M2  | Checkout                          | PIN login, roles, shifts with cash count, cash in/out, sale screen with loose quantities, FEFO with batch override, discounts, split payments (cash, card, JazzCash/Easypaisa/Raast, khata), hold/resume, void, returns, 80mm receipt and cash drawer, audit log, automatic local backups | A full day of sales runs on one till                                                                                   | 4 wks | Next     |
| M3  | Purchasing and stock control      | Suppliers, receiving with TP/discount/bonus, supplier balances and payments, optional purchase orders, returns to supplier, adjustments, stock counts, near-expiry and expired lists, expiry write-off                                                                                    | Stock can be received, returned to the distributor and counted                                                         | 3 wks |          |
| M4  | Customers, prescriptions, reports | Customers and khata, purchase history, prescription photo and prescriber, controlled-drug register, reports (daily sales, profit by item, cash reconciliation, expiry, dead stock, top sellers, stock value), expiry-loss dashboard                                                       | The single-store till is feature-complete and fully offline                                                            | 3 wks |          |
| M5  | Pilot release                     | Windows installer, signed auto-updates, setup wizard, receipt settings (name, NTN, address), import from Excel or the current software, error reporting                                                                                                                                   | Running in one real pharmacy                                                                                           | 2 wks |          |
| M6  | Cloud sync and backup             | Cloud API and PostgreSQL, device registration, two-way sync, cloud backup and restore                                                                                                                                                                                                     | Till data reaches the cloud when online; a dead PC can be restored                                                     | 4 wks |          |
| M7  | Owner dashboard                   | Sales, profit, stock value, expiry risk, staff activity                                                                                                                                                                                                                                   | The owner checks the store from a phone                                                                                | 3 wks |          |

**Phase 2:** multi-branch (stock transfers, central catalog, consolidated reports),
FBR POS integration (needed by chains), reorder suggestions, substitutes (same salt and
strength), drug interaction warnings, SMS/WhatsApp receipts and refill reminders, loyalty.

## M1 delivered

- pnpm workspace: `packages/config`, `packages/core`, `packages/db`, `apps/till`
- Core rules with tests: money in paisa, pack sizes, pack prices, expiry parsing and
  status in the store's time zone, FEFO allocation, quick quantity input (`1b 2t`), UUIDv7
- SQLite schema `0001-initial`: STRICT tables, append-only stock ledger and audit log,
  stock cache kept by trigger, sync outbox, trigram search index
- Services: setup, products (units, barcodes, salts), search, opening stock, adjustments,
  stock and expiry views, CSV import with a dry run
- Till screens: setup, products, product form, product detail with batches, stock and
  expiry, import
- Desktop app (Tauri) and browser preview (WebAssembly SQLite)
- Tests: unit tests (Vitest, node:sqlite), Rust tests, Playwright end-to-end tests
- CI: checks, end-to-end, Rust, Windows installer

## Open items carried into M2

- Users and PIN login: M1 runs as the owner account created at setup.
- Tax rates for medicines: unconfirmed (see `compliance-pk.md`); one 0% class is created.
- Local backups: planned for M2, before any pilot data exists.
- The till's PC clock: add a warning when it looks wrong (expiry checks depend on it).
