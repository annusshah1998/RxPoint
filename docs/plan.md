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

| #   | Milestone                         | Scope                                                                                                                                                                                                                                                                                                 | Done when                                                                                                              | Est.  | Status                                 |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------- |
| M1  | Foundations, catalog, stock       | Repo setup, CI, config, core rules (money, units, pricing, FEFO), SQLite schema and migrations, stock ledger, sync outbox, Tauri app with the Rust database bridge, catalog screens and search, CSV import, opening stock by batch                                                                    | A catalog CSV can be imported, current stock entered by batch and expiry, and any item found by brand, generic or salt | 3 wks | **Done**                               |
| M2  | Checkout                          | PIN login, roles, shifts with cash count, cash in/out, sale screen with loose quantities, FEFO with batch override, discounts, split payments (cash, card, JazzCash/Easypaisa/Raast; khata moved to M4), hold/resume, void, returns, 80mm receipt and cash drawer, audit log, automatic local backups | A full day of sales runs on one till                                                                                   | 4 wks | Built; review and hardware checks left |
| M3  | Purchasing and stock control      | Suppliers, receiving with TP/discount/bonus, supplier balances and payments, optional purchase orders, returns to supplier, adjustments, stock counts, near-expiry and expired lists, expiry write-off                                                                                                | Stock can be received, returned to the distributor and counted                                                         | 3 wks |                                        |
| M4  | Customers, prescriptions, reports | Customers and khata, purchase history, prescription photo and prescriber, controlled-drug register, reports (daily sales, profit by item, cash reconciliation, expiry, dead stock, top sellers, stock value), expiry-loss dashboard                                                                   | The single-store till is feature-complete and fully offline                                                            | 3 wks |                                        |
| M5  | Pilot release                     | Windows installer, signed auto-updates, setup wizard, receipt settings (name, NTN, address), import from Excel or the current software, error reporting                                                                                                                                               | Running in one real pharmacy                                                                                           | 2 wks |                                        |
| M6  | Cloud sync and backup             | Cloud API and PostgreSQL, device registration, two-way sync, cloud backup and restore                                                                                                                                                                                                                 | Till data reaches the cloud when online; a dead PC can be restored                                                     | 4 wks |                                        |
| M7  | Owner dashboard                   | Sales, profit, stock value, expiry risk, staff activity                                                                                                                                                                                                                                               | The owner checks the store from a phone                                                                                | 3 wks |                                        |

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

## M2 so far

Design and re-estimate: `m2-design.md` (about 175 h, not 4 weeks; needs the owner's
sign-off because the pilot date moves).

Built and tested:

- PIN login, roles (owner, pharmacist, cashier, inventory), lock and idle lock, owner
  recovery code, staff screen
- Approvals with a second person's PIN, scoped to the exact line and amount
- Shifts: opening float by note count, pay-outs, blind close with a variance note, report
- Sale screen (the home screen): scan or search, loose quantities (`2s*pana`), pack
  sizes, FEFO with a batch picker (F4), warnings for past-zero stock, above-MRP and near
  expiry; expired batches are blocked
- Discounts per line and per bill with role caps; items can be marked never discounted
- Controlled drugs: the batch on the pack (picked or typed), prescription details and a
  pharmacist's PIN
- Pay: cash with quick amounts, card and wallet with references, split payments; khata
  waits for customer accounts (M4)
- Hold and resume, drafts that survive a reload or power cut, void with approval, sales
  list and reprint
- Receipts: 80mm ESC/POS layout with a golden test and an on-screen preview; printing is
  off by default, so the till works without a printer or scanner
- Printing (M2b): a Windows printer (RAW) or a network printer (port 9100), set per till in
  Settings with a test page; the cash drawer opens through the printer for cash sales,
  refunds, cash in/out and Open drawer; a failed print never blocks a sale (Retry, Show on
  screen) and a receipt that may not have printed is asked about at the next start; tested
  against `scripts/fake-printer.mjs`
- Backups in the desktop app: automatic and by hand, checked after each copy, old copies
  thinned; Backups and Settings screens
- Record checks (`checkRecords`) over a full simulated day of sales, voids and returns
- Returns from the Sales screen: part or all of a sale, back on the shelf unless the batch
  has expired, refunds rounded so all returns add up to the sale total, paid back the way
  the sale was paid (card and wallet capped, cash limited to the drawer); a pharmacist's
  PIN for cashiers, the owner's after the return window (7 days), a return receipt

M2a (a full day of sales on one till) is done: the clock warning banner, the
scanner-speed detector, keyboard shortcuts with F1 help and a full-day browser test are
built too. In M2b, printing and the cash drawer are built (not yet tried on a real
printer), and WebView2's browser keys (F5, Ctrl+R, Ctrl+P, Ctrl+F…) are off in the desktop
app (not yet checked by hand on Windows 10 or 11). Each backup is also copied to a
backup drive (a USB stick or a second drive, set per till in Settings → Backups); a
missing drive never stops a backup or a sale, and a badge appears when nothing has been
copied for 3 days. The Backups screen can check any backup file.

The M2 decisions are recorded in ADRs 0005–0011 (`docs/decisions/`): checkout records and
signed payments, drafts and idempotent completion, PIN login and scoped approvals,
printing and the drawer, backups and number floors, the clock guard, and khata in M4.

Still to do for M2: a code review of all M2 work, then the merge into `main` (the owner
first makes `main` the default branch), and the hardware checklist in `m2-design.md` §6.4
(printer, drawer, scanner, the browser keys on Windows 10 and 11, a USB stick) once a
printer and scanner arrive.

## Open items after M2

- Tax rates for medicines: unconfirmed (see `compliance-pk.md`); one 0% class is created.
- Before the first installer that carries a new migration: the pre-migration backup
  (designed, not built; ADR 0009).
- Before the restore screen (M5): the shared Rust file lock between backup and restore,
  and refusing a restore when the old WAL files can't be removed (ADR 0009).
- The shift's Z report is shown but not printed yet (ADR 0008).
- Owner sign-off on the M2 re-estimate and the open questions in `m2-design.md` §12.
