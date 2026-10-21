# M2 Checkout — design

> **How to read this.** This is the agreed design for milestone 2, written before most of
> the code. Where the code differs, the code wins. Differences so far:
>
> - **No migration 0003.** Migration 0002 had not shipped (it was never on `main` or in an
>   installer), so `draft_approval` was given its scoped shape (§2.2) inside 0002 itself.
> - **Built:** core rules including `approvals.ts`, `normalizeCart`, `lineQtyProblem`,
>   `needsExpiryCheck` (called `needsConfirm` below); migration 0002; PIN login, lockout,
>   recovery code, staff management and permissions; store and device settings; the clock
>   guard (implausible blocks, behind warns, `clock.reset`); shifts with blind close.
> - **Still to build:** drafts, checkout, void, receipts, the sale screen, backups and the
>   rest of §10.

This revision is based on `8290351`, the tip of the working branch. Since the first draft, three commits have built part of the design:

- `7837bcd`: the Rust side of printing, backups and restore, plus a Windows CI job (§8).
- `8ed4541`: the core checkout rules (§3).
- `8290351`: migration `0002-checkout`, `schema.ts` and the M1 service changes for the new columns (§2).

For each part, this document says what is built, what this revision changes in it and what is still to do. It keeps three things from the earlier designs:

- **Design A's record model:** a signed payment ledger, immutable sales with a separate void row, frozen batch allocations, cumulative refunds and an "unrecorded stock" batch.
- **Design B's cashier flow:** a pure cart reducer, draft saves outside `useAction`, approval grants, the keyboard map and cumulative return rounding.
- **Design C's fit and robustness:** the existing PIN code, only replay-safe triggers, boot-time recovery and an owner recovery code.

It fixes every justified point in the critique. The verdicts are in **Review notes** at the end.

### What I checked in the repository

- **Branches and CI**
  - `git remote show origin` reports the working branch, not `main`, as the remote HEAD.
  - `origin/main` is at `dede5b2`. That commit is an ancestor of `8290351` and 5 commits behind it (`372cc2b`, `b9f54e4`, `7837bcd`, `8ed4541`, `8290351`).
  - None of those commit messages has an AI attribution line.
  - `ci.yml` runs on every push and PR. `windows.yml` runs clippy, the tests and the installer on `windows-latest`. It triggers on `main`, on tags, on PRs that touch `apps/till/src-tauri/**`, and by hand.
- **Tests:** `pnpm test` at `8290351` passes 256 tests in 27 files.
- **Core (`8ed4541`):** every module in §3 exists. These names differ from the first draft:
  - `effectiveCapBp(roleCapBp, defaultBp)` replaces `capBp(role, s)`.
  - Pricing throws a typed `PricingError('discount_exceeds' | 'not_discountable' | 'invalid_discount', lineKey)`.
  - `PricedLine.lineDiscountBp` and `PricedSale.billDiscountBp` exist.
  - `isSuspiciousTender` is `tendered > due + 500000 || (due > 0 && tendered > 10×due && tendered > due + 10000)`.
  - `pin.ts` adds `isLocked` and `normalizeRecoveryCode`.
  - `cart.ts` adds `undo`, `CartProduct` and `defaultSaleUnit`.
  - `CHECKOUT_DEFAULTS` is in `@app/config`, and `AppError(code, message, fields, details)` has the new codes.
- **Schema (`8290351`):**
  - Migration 0002 is exactly the first draft's §2, using `appendOnly`, `bool` and `isDate` from `migrations/sql.ts`. `SYNCED_TABLES` is updated.
  - Product writes include `allow_discount`, and opening stock writes `is_placeholder = 0`.
  - `planFefo` skips placeholders, and `BatchStock` has `isPlaceholder`.
  - `0002-checkout.test.ts` covers every guard.
- **Committed services** are M1 only: setup, catalog, search, stock and import.
  - `loadSession` makes the owner the acting user.
  - `openDatabase(executor)` has no pre-migration hook.
  - `ServiceContext` is `{db, now, newId, timeZone}`.
- **Uncommitted work in the working tree** follows the first draft. It covers auth, users, guards, settings, `meta.ts`, the login and staff screens, and `login.spec`.
  - It already has `pinIterations` and `buildTime` on `ServiceContext`, `APPROVABLE_PERMISSIONS` / `isApprovable`, and FORBIDDEN for permissions that can't be approved.
  - It still has the unscoped `draft_approval` grant (`limit_bp` is the approver's whole cap, and `needBp` comes from the client), `clock.override`, and the rule that a clock more than 24 h behind blocks sales.
  - §10 step 1 lists what it must change.
- **Receipts (`b9f54e4`, unchanged since):**
  - `renderEscPos` sends the drawer pulse after the cut.
  - `wrap()` drops leading spaces.
  - There are no barcode or feed lines. Widths are `mm80: 48` and `mm58: 32`.
  - The text preview letter-spaces large text.
  - The package has no dependency on `@app/core`, and the till doesn't use it yet.
- **Rust (`7837bcd`)** has these commands:

  | Command                                                                                              | Shape and behaviour                                                                                                                                                                                                             |
  | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `db_execute(sql, params)`, `db_reset()`                                                              | Unchanged since M1                                                                                                                                                                                                              |
  | `app_info()`                                                                                         | Synchronous; returns `{dataDir, backupDir, version}`                                                                                                                                                                            |
  | `print_raw(target, bytes)`                                                                           | `target` is `{mode: 'windows', printerName: string \| null}` or `{mode: 'network', host, port}`. Refuses empty jobs and jobs over 256 KB. Network: 3 s connect timeout, 5 s write timeout.                                      |
  | `printer_list()`                                                                                     | `[{name, isDefault}]`                                                                                                                                                                                                           |
  | `backup_create(name)`, `backup_verify(name)`                                                         | Return `BackupCheck {name, sizeBytes, integrityOk, integrity, migrations, saleCount, lastSaleAt, outboxSeq}`. `VACUUM INTO` from a second read-only connection into `.partial`, then sync, `PRAGMA integrity_check` and rename. |
  | `backup_list(dir?)`, `backup_delete(name, dir?)`, `backup_copy(name, destDir)`, `folder_check(path)` | `dir` defaults to the backups folder                                                                                                                                                                                            |
  | `backup_restore(name, safetyName)`                                                                   | See the steps below                                                                                                                                                                                                             |
  - **`backup_restore` steps:** refuse inside a transaction; check the backup; write the safety copy with `VACUUM INTO` on the main connection; stage `till.db.restoring`; close; delete `-wal`/`-shm` **ignoring errors** (`let _ = fs::remove_file`); rename; reopen.
  - **`check_name`** accepts any `till-*.db` name of up to 64 characters from `[A-Za-z0-9._-]` with no `..`. The tests use `till-1-auto.db`.
  - **`Database::open` never fails.** If the file can't be opened, queries return "The database could not be opened: …".
  - **Start-up** removes `.partial` files. Nothing handles a leftover `.restoring` file, and there is no restore marker.
  - **`Cargo.toml`** uses `windows-sys 0.61` (Win32_Foundation, Win32_Graphics_Gdi, Win32_Graphics_Printing) for the spooler.

- **Locked versions:**
  - Tauri 2.12.2, tauri-runtime-wry 2.12.3 and wry 0.57.0. wry has `with_browser_accelerator_keys`, but tauri-runtime-wry never calls it.
  - `windows` / `windows-core` 0.62.2 and `webview2-com` 0.39.1 are already in `Cargo.lock`.
  - The bundled SQLite is 3.53.2.
- **Verified by running in this revision** (core at HEAD, node:sqlite):
  - **The worked example:**
    - shares 980 / 147 / 1047 / 0, subtotal 196539, total 196500, rounding −39, tax 13729;
    - cap need 1180 bp; MRP 55333;
    - refund 24010 → 24000; cost 41650 → 20825;
    - card + cash gives cash 96500 with change 3500; expected cash 557500.
  - **Zero totals:** `settleTenders(0, [])` returns ok with no payments, and `settleTenders(0, [cash])` returns `cash_not_needed`. A 4-paisa subtotal rounds to a total of 0.
  - **Allocation:** PN-01 has 5 in date, PN-00 has 20 expired, sell 10. Result: PN-01 5 + unrecorded 5 with `expiredOnly: false` (critique item 3). The table's "sell 50" case also has `expiredOnly: false` with 10 expired units on record.
  - **Errors:** `priceForQty({43620/6}, 8961234567890 × 6)` throws "divRound needs safe integers". A Rs 100 fixed discount on a Rs 72.70 line throws `PricingError('discount_exceeds')`.
  - **Migration 0003 (§2.2)** applies on top of 0002: its CHECKs, cascade and upsert work, and an `UPDATE` save on a deleted draft changes 0 rows.
  - **Receipt sample (§6.2):** every line is at most 48 columns, laid out with the package's `pairLine` at width 48 (46 plus a 2-space indent).

---

## 1. Decisions

| #   | Topic                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Why                                                                                                                                                                                                                                     |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | "Main should be default"  | **1. Push the commits under a neutral name:** `git push origin 8290351:refs/heads/m2-groundwork`. **2. Open one PR** from `m2-groundwork` into `main` and merge it with **Create a merge commit**, not squash or rebase, so the commit ids in this document stay valid. **3. Make `main` the default branch:** `gh repo edit annusshah1998/RxPoint --default-branch main`, or Settings → General → Default branch. **4. From then on**, every step is a short branch off `main`, merged by PR, with no AI attribution (CLAUDE.md). The uncommitted work moves to a branch off `main` (`git stash`, `git switch -c m2-auth origin/main`, `git stash pop`). **5. Frozen migrations:** once 0002 is on `main`, installers are built from it, so 0001 and 0002 count as shipped and changes go into new migrations (0003). **6. Home screen:** the Sale screen becomes the home screen after login.                                     | The remote's HEAD is the working branch, and the installer job runs only on `main`. A PR or merge message built from the working branch's name would put a tool name into commit text. Q1 confirms this reading.                        |
| D2  | Above MRP                 | **Warn, never block** (owner). A line is above MRP when its **net** (after the line discount and its share of the bill discount, i.e. what the customer pays) is more than the MRP of the units it takes, summed over its batch allocations. It shows as a chip and in the Pay summary. It is stored as `sale_line.above_mrp` and audited as `sale.above_mrp`. Alt+M sells the line at MRP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | It checks what is actually charged. The chip appears when the item is scanned and clears if a discount brings the price under MRP.                                                                                                      |
| D3  | No printer or scanner     | **Printing is Off by default.** One receipt document is shown on screen (48-column preview) and later becomes ESC/POS bytes. The status bar says "Printing off — receipts shown on screen" (a notice, not an error). **Barcodes:** a barcode typed by hand plus Enter behaves exactly like a scan, and a 6–14-digit value entered in a Qty or discount field is treated as a scan however slowly it was typed. **Drawer:** it opens only through the printer. **Printer modes:** Off, Windows and Network. The whole print path is tested with `scripts/fake-printer.mjs` on 127.0.0.1:9100 in Network mode. **No File mode:** the fake printer covers that path without a Rust change.                                                                                                                                                                                                                                             | Owner decision. Every feature can be tested today.                                                                                                                                                                                      |
| D4  | Sales never stop          | **Selling past zero** is allowed and logged. **Every shortfall goes to the product's placeholder "Unrecorded stock" batch**, so real batches are never driven negative on a guess. **Expired stock on record:** whenever a line sells beyond in-date stock while expired stock of that product is on record, the cashier confirms that the packs in hand are in date. That covers both "all recorded stock is expired" and "5 in date, 20 expired". **Expired batches** are blocked by the service and by a trigger that is safe to replay.                                                                                                                                                                                                                                                                                                                                                                                         | Records stay honest for recalls and the controlled register. The expired units on the shelf are the likeliest source of the extra packs.                                                                                                |
| D5  | **Khata**                 | **Deferred to M4.** M2 services refuse `khata` (`NOT_AVAILABLE`: "Khata comes with customer accounts"), and the tender is greyed out. **What M4 adds:** `customer`, a **`khata_payment` table for collections**, limits and statements. **Credit sales:** they use `payment.method = 'khata'` with `ALTER TABLE payment ADD COLUMN customer_id TEXT REFERENCES customer (id)`, which SQLite allows because the default is NULL. **Collections** fit neither cash table: `payment.sale_id` is NOT NULL, `doc_type` is limited to sale/void/return, and `cash_movement` has no collection category. M4 therefore changes expected cash to float + Σ cash payments + Σ cash movements + Σ cash khata collections, and updates `getShiftTotals`, `checkRecords` and ADR 0011 with it.                                                                                                                                                   | Credit without a customer ledger, collections and limits is a receivable no one can chase. A "minimal customer" would be rebuilt in M4. The pilot is after M5, so khata exists before any real store uses the till.                     |
| D6  | Money record              | One append-only **`payment`** table with signed amounts. `doc_type` is `sale` (+), `void` (−) or `return` (−), and every row belongs to a shift. **`sale` is fully immutable.** A void is a `sale_void` row plus reversing movements and payments. **Expected cash** = opening float + Σ cash `payment.amount` + Σ `cash_movement.amount` for the shift. **A sale with total 0** (100% discount, a zero price, or a subtotal under 50 paisa that rounds to 0) has no payment rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Everything reconciles from inserts. No status flags.                                                                                                                                                                                    |
| D7  | Pricing order             | 1. gross = `priceForQty(packPrice, qty)`, the only rounding of a price. 2. Line discount. 3. Bill discount, split pro rata by largest remainder over discountable lines. 4. Tax extracted **per line** (prices include tax). 5. One bill rounding (default nearest Rs 1), shown on the receipt. Services check discounts and quantities **before** pricing, so a `PricingError` never reaches the UI as a bug.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Matches ADR 0002. Per-line tax keeps returns simple, and line taxes add up exactly to the total.                                                                                                                                        |
| D8  | The open sale             | **Draft row:** a local `sale_draft` row is created when a cart starts (`startDraft`), so it exists before any approval. **Saves:** a 150 ms debounce `UPDATE`s only `cart_json`, `line_count`, `total` and `updated_at`. They never insert a row and never write `status`. **Flush:** the screen cancels the debounce and awaits one save before `completeSale`, `holdDraft`, `resumeDraft`, `discardDraft`, `grantApproval` and locking. **Completing:** `completeSale` reads the cart from the draft row, and **`sale.id = draft.id`**.                                                                                                                                                                                                                                                                                                                                                                                           | A crash, reload or power cut loses at most the last 150 ms of typing. A late save can't bring back a completed or discarded cart, and completing twice returns the same sale.                                                           |
| D9  | Login                     | Pick your name, then type your PIN. PINs use the existing PBKDF2, with `ctx.pinIterations` (120k; tests 1,000), verified **outside** any transaction. **Lockout** is per user in `pin_attempt`. **Owner PIN:** 6 digits, with a one-time **recovery code**. **Locking:** Ctrl+L or 5 idle minutes; the cart is kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Fits `pin.ts`. There is no PIN-uniqueness oracle.                                                                                                                                                                                       |
| D10 | Permissions and approvals | **Role table:** `core/permissions.ts`. Services call `authorizeTx` **inside** the transaction, reading the role and `is_active` fresh. **FORBIDDEN or NEEDS_APPROVAL:** a missing permission is `FORBIDDEN` unless it is marked approvable (§3.8); then it is `NEEDS_APPROVAL`, and a qualifying user enters their PIN. **Ordinary approvals** go with the one action and are used once. **Draft-bound approvals** (discount over cap, controlled dispensing, later price override) are **scoped**: they record exactly what was approved (line, product, quantity, price, discount and bill discount; for controlled lines the batches and the prescription), the bp actually approved and who was selling. If any of that changes, the approval no longer covers it. Holding the sale clears them, and a different user completing the sale can't use them. **Discounts** use per-role caps; the store default is always allowed. | The service is the authority; the UI only hides buttons. An approval covers what the approver saw, nothing more.                                                                                                                        |
| D11 | Document numbers          | **Invoices:** `T1-000123`, numbered `max(MAX(invoice_seq) + 1, invoice_floor)` per device inside the completing transaction, so there are no gaps. **Returns:** `T1-R000012`. **After a restore (M5)**, the floor is the old database's maximum + 1 when it is readable, else the restored maximum + 1000. The floors live in `local_meta` and are read from M2 on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | No counter can drift, and numbers are never reused after a restore.                                                                                                                                                                     |
| D12 | Clock                     | **High water:** `local_meta.clock_high_water` is raised by every document write and by opening a shift; login doesn't raise it. **Implausible** (before the build time − 1 day, or after 2035): **blocks** opening a shift and every document until the Windows clock is fixed. There is no override. **Behind by more than 10 min:** a warning only. Documents carry the PC's own date, and `clock.suspect` is audited once per shift. A pharmacist or the owner can **reset** the high water (`clock.reset`) when the PC clock is right. **More than 3 days ahead:** the date is confirmed once at Open shift. **Business dates** (shift, sale, return) are the PC's date in Karachi. **Expiry checks alone** use `effectiveToday = max(today, localDate(highWater))`. Who fixes each case is in §4.8.                                                                                                                            | A clock moved back can't unblock expired stock. A dead CMOS battery can't write records dated 2009. A cashier-only shift keeps selling when the clock is merely off, and a forward jump no longer future-dates every document after it. |
| D13 | Triggers                  | Only triggers that hold for **any replay order of valid history**: append-only tables, a closed shift is final, frozen expiry not before the sale date, no over-return, no void after a return, a void only from the sale's own shift. "Only into an open shift" stays in the services.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Safe for the M6 cloud restore and replay.                                                                                                                                                                                               |
| D14 | Backups                   | **How (built in `7837bcd`):** `VACUUM INTO` from a **second read-only connection** (never blocks a sale) to a `.partial` file, then `integrity_check`, fsync and rename. **When:** before migrations (`premigrate`; its log row is written after migrations, because `backup_log` may not exist yet); at login if the last good one is over 24 h old; every 2 h when data changed and the till is idle; at shift close; on demand. **Retention:** old copies are thinned by a fixed rule. **Mirror:** a copy can go to a second folder in M2b. **Restore:** the Rust command gets a shared file lock and refuses when the WAL files can't be removed. The restore screen, marker and number floors come in **M5**, before the pilot.                                                                                                                                                                                                | Data must survive the PC, not only power cuts. Restore isn't needed for "a full day of sales" but is before real data exists.                                                                                                           |
| D15 | Rx and controlled drugs   | **Rx-required lines:** one "Prescription seen?" answer per sale. Both answers are allowed and recorded (`sale.rx_check`), with `not_seen` audited; a setting can require "seen". **Controlled lines (Schedule B/D):** the batch must be picked from the pack. If no recorded batch matches, the batch no. and expiry are typed from the pack and a **real batch** is created (source `adjustment`), never the placeholder. A prescription is captured (`sale_prescription`, **one per sale**: items from two prescriptions are two sales). The dispenser is a pharmacist or the owner, or a cashier with a pharmacist's PIN approval scoped to those lines.                                                                                                                                                                                                                                                                         | Gives M4's register a real batch, patient, prescriber and dispenser for every supply.                                                                                                                                                   |
| D16 | Scope and estimate        | **Re-estimated per step in hours (§10):** about **128 h** for M2a (a full day of sales) and **47 h** for M2b (returns, controlled capture, printing). That totals about **175 h** (likely 140–210 h), or **15–17 weeks at 10–12 h/week, not 4**. **Out of M2:** price override (Alt+P), the File print mode (dropped), the audit-log viewer (M4), the Health screen (M5; `checkRecords` stays as a test helper), the restore screen and number floors (M5), and the clock override (removed). **Needs the owner's sign-off** (Q16), because the pilot date moves.                                                                                                                                                                                                                                                                                                                                                                   | Honest for a solo, part-time developer. The uncommitted auth work may shorten steps 2–5.                                                                                                                                                |

---

## 2. Schema

### 2.1 Migration `0002-checkout` (committed in `8290351`)

Changes to M1 tables (ADD COLUMN only):

- `product.allow_discount` (default 1).
- `batch.is_placeholder` (default 0), with `batch_placeholder_uq` (one placeholder per product).
- `audit_log.approved_by`, with an index on `audit_log (action, created_at)`.

| Table               | Synced  | Key rules                                                                                                                                                                                                                                                                                             |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sale_draft`        | local   | One `active` row per device (partial unique index). `held_at` is set exactly when the row is `held`. `cart_json` must be valid JSON.                                                                                                                                                                  |
| `draft_approval`    | local   | **Rebuilt by 0003** (§2.2)                                                                                                                                                                                                                                                                            |
| `pin_attempt`       | local   | `failed_count` and `locked_until` per user                                                                                                                                                                                                                                                            |
| `backup_log`        | local   | `kind`, `status`, `outbox_seq`, `mirror_status`                                                                                                                                                                                                                                                       |
| `setting`           | mutable | `(branch_id, key)` unique; `value_json`                                                                                                                                                                                                                                                               |
| `shift`             | mutable | **Uniqueness:** one open shift per device, and `shift_no` unique per device. **Closing:** a closed shift has every close field, `variance = counted − expected` and `float_left ≤ counted`. **`shift_guard`:** a closed shift is final and the opening fields never change. Shifts are never deleted. |
| `cash_movement`     | append  | Signed `amount` (pay_in > 0, pay_out < 0). Category from a fixed list. Note of 1–200 characters.                                                                                                                                                                                                      |
| `sale`              | append  | `(device_id, invoice_seq)` unique. `subtotal = gross − line discounts − bill discount` and `total = subtotal + rounding`. Rounding within ±1000. `tax_total ≤ subtotal`.                                                                                                                              |
| `sale_line`         | append  | `net = gross − line_discount − bill share`. An override needs a reason. Frozen `above_mrp`, Rx and schedule.                                                                                                                                                                                          |
| `sale_line_batch`   | append  | `movement_id` unique. Frozen `batch_no`, expiry, cost, MRP and `stock_before`. A trigger refuses an expiry before `sale.business_date`.                                                                                                                                                               |
| `sale_prescription` | append  | One per sale                                                                                                                                                                                                                                                                                          |
| `sale_void`         | append  | One per sale                                                                                                                                                                                                                                                                                          |
| `sale_return`       | append  | `(device_id, return_seq)` unique; `refund_total = refund_net + rounding`                                                                                                                                                                                                                              |
| `sale_return_line`  | append  | `restock` is set exactly when `movement_id` is                                                                                                                                                                                                                                                        |
| `payment`           | append  | **Signs:** a `sale` row is exactly a positive amount. **Wallets:** `wallet` rows exactly have a provider, and a sale's wallet reference must be ≥ 4 characters (with `COALESCE`). **Tendered and change** appear only on cash sale rows, with `tendered − change = amount`.                           |

**Triggers:**

- An append-only UPDATE/DELETE pair on every `append` table above.
- `shift_guard` and `shift_no_delete`.
- `sale_line_batch_not_expired`.
- `sale_void_guard` (same shift, no returns), `sale_return_not_voided` and `sale_return_line_guard` (no over-return; the line, allocation and batch must match).

**Rules kept in the services,** because they depend on replay order: documents only into an open shift; a cash refund no larger than the drawer; an allocation matching its movement. `checkRecords` (§4.13) verifies all three.

**`local_meta` keys** (`packages/db/src/meta.ts`):

| Key                             | Holds                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `clock_high_water`              | Latest document or shift-open time                                                                        |
| `invoice_floor`, `return_floor` | Lowest allowed next numbers (set by restore, M5)                                                          |
| `device_settings`               | JSON: printer, drawer and mirror folder for this PC                                                       |
| `recovery_hash`                 | Hash of the owner recovery code                                                                           |
| `last_receipt`                  | JSON `{docType, docId, status}`, written **inside** the document's transaction when printing is on (§6.4) |

`clock_override` is dropped along with the clock override.

### 2.2 Migration `0003-scoped-approvals` (new)

`draft_approval` is local-only and holds approvals for open drafts only, so it is rebuilt rather than altered. An approval pending at upgrade time is simply asked for again.

```sql
DROP TABLE draft_approval;
CREATE TABLE draft_approval (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES sale_draft (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('sale.discount', 'sale.controlled', 'sale.price_override')),
  line_key TEXT NOT NULL,                                      -- cart line approved; '' = the whole bill
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),     -- grantScope(): exactly what was approved
  approved_bp INTEGER CHECK (approved_bp BETWEEN 0 AND 10000), -- the discount need when approved, not the approver's cap
  requested_by TEXT NOT NULL REFERENCES app_user (id),         -- who was selling
  approver_id TEXT NOT NULL REFERENCES app_user (id),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'sale.discount') = (approved_bp IS NOT NULL)),
  CHECK (approver_id <> requested_by)
) STRICT;
CREATE UNIQUE INDEX draft_approval_scope_uq ON draft_approval (draft_id, kind, line_key);
```

- **Writes:** `grantApproval` upserts with `ON CONFLICT (draft_id, kind, line_key) DO UPDATE`, so asking again replaces the earlier approval.
- **`schema.ts`:** `DraftApprovalTable` gets the same columns.
- **Registration:** the migration goes in `migrations/index.ts`.

---

## 3. Core rules (`packages/core`, pure, no I/O)

Money is paisa. Quantities are base units. Rates are basis points (bp; 100 = 1%). Every split uses `divRound` (halves away from zero).

**Status:** every module except `approvals.ts` (§3.13) is **built** (`8ed4541`). Items marked **Change** are step 1 of §10.

### 3.1 `checkout.ts` (built)

```ts
export type DiscountSpec = { kind: 'percent'; bp: number } | { kind: 'amount'; amount: Money };
export interface RoundingRule {
  step: Money /* 1 = off, 100, 500, 1000 */;
  mode: 'nearest' | 'down';
}
export class PricingError extends Error {
  reason: 'discount_exceeds' | 'not_discountable' | 'invalid_discount';
  lineKey?;
}
export function lineDiscountAmount(gross, spec, key?): Money; // amount > gross → PricingError
export function allocateProRata(total, weights): Money[]; // largest remainder, ties to the lower index, BigInt inside
export function extractTax(inclusive, rateBp): Money; // divRound(inc×rate, 10000+rate)
export function roundBill(amount, rule): { total; rounding };
export function priceSale(
  lines: PricingLine[],
  bill: DiscountSpec | null,
  s: { defaultDiscountBp; rounding },
): PricedSale; // lines with gross, lineDiscount, billShare, net, tax,
// discountSource, lineDiscountBp; totals; taxByRate
export function effectiveCapBp(roleCapBp, defaultDiscountBp): number; // max: the default is always allowed
export function discountWithinCap(d, gross, capBp): boolean; // d×10000 ≤ capBp×gross + 10000 (1 paisa of slack)
export function discountNeedBp(d, gross): number; // ceil(max(0, d−1)×10000 / gross)
export function allocationMrp(qty, batch: { mrp; packQty }): Money | null;
export function isAboveMrp(net, qty, known: { mrp; qty }): boolean; // only allocations with an MRP count
```

**`priceSale` steps:**

1. Gross per line.
2. Resolve the discount: `'default'` becomes the store default on discountable lines, and an explicit spec on a non-discountable line throws.
3. `after = gross − lineDiscount`.
4. Bill discount: a percent of `Σ after` over discountable lines, or a fixed amount (more than that base throws). It is split pro rata.
5. Tax per line on the net.
6. Round the subtotal once.

**Callers never let it throw on user input:** `buildSaleTx` checks discounts first (§4.6), and the cart reducer drops fixed discounts that no longer fit (§3.6).

**Worked example** (defaults: no store discount, nearest Rs 1):

| Line                             | Price        | Qty | gross                          | line disc  | after | bill share (2%) | net   | tax   |
| -------------------------------- | ------------ | --- | ------------------------------ | ---------- | ----- | --------------- | ----- | ----- |
| L1 Panadol 500mg "2s"            | {73500 / 30} | 20  | 49000                          | 0          | 49000 | 980             | 48020 | 0     |
| L2 Brufen 400mg "3t"             | {24567 / 10} | 3   | **7370** (not 3 × 2457 = 7371) | 0          | 7370  | 147             | 7223  | 0     |
| L3 Augmentin 625mg "1s 2t"       | {43620 / 6}  | 8   | 58160                          | 10% = 5816 | 52344 | 1047            | 51297 | 0     |
| L4 Thermometer, no discount, 18% | {89999 / 1}  | 1   | 89999                          | 0          | 89999 | 0               | 89999 | 13729 |

- billBase = 108714, and 2% = `percentOf(108714, 200)` = 2174.
- The raw shares are 979.87 / 147.38 / 1046.74. Their floors add to 2172, so the 2 leftover paisa go to L1 (.87) and L3 (.74).
- 204529 − 5816 − 2174 = subtotal 196539, which rounds to **total 196500, rounding −39**.
- tax_total = `extractTax(89999, 1800)` = 13729 (13728.66).

**Discount cap:**

- L3 has d = 5816 + 1047 = 6863 on a gross of 58160.
- Against a cashier cap of 500: 68,630,000 > 29,090,000, so approval is needed.
- Need = **1180 bp (11.80%)**. A pharmacist's 1500 covers it.
- **The slack:** a 5% bill discount over Rs 49.99 + Rs 50.01 gives shares [250, 250]. Checking 250 against 49.99 passes only because of the one paisa of slack.

**Above MRP:**

- Augmentin batch AU1123 has MRP {41500 / 6}. Eight tablets at the catalog price: net 58160 > MRP 55333, so it warns (Rs 28.27 over).
- "Sell at MRP" uses the lowest MRP among the line's allocations, giving gross 55333.
- With the worked sale's 10% discount, L3's net is 51297 ≤ 55333, so the chip clears.

### 3.2 `tenders.ts` (built)

```ts
export type Tender =
  | { method: 'cash'; tendered }
  | { method: 'card'; amount; reference? }
  | { method: 'wallet'; provider: 'jazzcash' | 'easypaisa' | 'raast' | 'other'; amount; reference }
  | { method: 'khata'; amount };
export function settleTenders(
  total,
  tenders,
):
  | { ok: true; payments; cashApplied; change }
  | {
      ok: false;
      problem:
        | 'short'
        | 'non_cash_over_total'
        | 'cash_not_needed'
        | 'wallet_reference'
        | 'zero_amount'
        | 'khata_unavailable';
      index?;
      short?;
    };
export function suggestCash(due): Money[]; // [due, next Rs 100 / 500 / 1,000 / 5,000], deduped
export function isSuspiciousTender(due, tendered): boolean;
```

- **How cash is settled:** card and wallet together must be ≤ the total. Cash rows merge into one: amount = total − non-cash, tendered = Σ cash, change = tendered − amount. The cash row exists only when that amount is > 0.
- **Example:** a total of 196500 paid with card 100000 (ref 4417) plus cash tendered 100000 gives card +100000 and cash +96500 (change 3500). `suggestCash(96500)` = [96500, 100000, 500000].
- **Total 0:** `settleTenders(0, [])` is ok with no payments and change 0. Any cash tendered is `cash_not_needed`.

### 3.3 `allocation.ts` (built; **Change**)

```ts
export function allocateForSale(
  lots: SaleLot[],
  qty,
  o: { today; manual? },
):
  | { ok: true; parts: SalePart[]; shortfall; expiredQty; expiredOnly; needsConfirm } // needsConfirm is new
  | { ok: false; error: 'expired' | 'unknown_batch' | 'manual_qty'; batchId? };
export function applyParts(lots, parts): SaleLot[]; // working copy shared by lines of one product
export function allocationCost(
  qty,
  batch,
  productCost,
  placeholder,
): { cost; source: 'batch' | 'product' | 'unknown' };
```

- **Automatic:** FEFO over the real lots (expired lots and lots at or below 0 are skipped). The shortfall becomes one `'unrecorded'` part on the placeholder.
- **Manual:** each pick must be a non-expired lot of this product, the picks must add up to the quantity, and a pick may take a batch below zero.
- **Change:** `needsConfirm = shortfall > 0 && expiredQty > 0`. `expiredOnly` (`shortfall === qty`) only picks which message to show.

Example (today 2026-10-21): PN-00 (expires 2026-09-30, 10 in stock, expired), PN-01 (2027-01-31, 15) and PN-02 (2027-06-30, 30).

| Request                                    | Result                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| 20                                         | PN-01 15 + PN-02 5                                                          |
| 50                                         | PN-01 15 + PN-02 30 + unrecorded 5; **needsConfirm** (10 expired on record) |
| Manual PN-02 × 40                          | PN-02 40 (stock_before 30, ends at −10)                                     |
| Manual PN-00                               | `{ok: false, error: 'expired'}`                                             |
| Only PN-00 on record, sell 10              | unrecorded 10; `expiredOnly`, needsConfirm                                  |
| PN-01 has 5, PN-00 has 20 expired, sell 10 | PN-01 5 + unrecorded 5; needsConfirm (the "some in date" message)           |
| Batch expiring today, sell 2               | Allowed                                                                     |

Cost: 20 tablets at {62475 / 30} cost 41650 (`'batch'`). Placeholder lots use the product's usual cost (`'product'`).

### 3.4 `returns-math.ts` (built)

- `refundShare(total, totalQty, prevQty, prevAmount, qty)` = `divRound(total×(prevQty+qty), totalQty) − prevAmount`. It is used for line net, line tax and allocation cost.
- `refundTotal({...})`: a final return refunds the sale total − what was refunded before. Otherwise rounding is cumulative.
- `splitReturnQty(allocs, qty)` takes the last allocation first.

**Example:** return 10 of L1's 20 tablets.

- `refundShare(48020, 20, 0, 0, 10)` = 24010, so the refund is **24000** (rounding −10).
- Cost is 20825.
- Returning everything else later is final: 196500 − 24000 = **172500**.

### 3.5 `shift-math.ts` (built)

`expectedCash(float, cashPayments, cashMovements)`, `PKR_NOTES`, `countTotal`.

Example: 500000 + (96500 − 24000) − 15000 (tea) = **557500**. Counted 557000 gives a variance of −500 (Rs 5 short; no note needed under Rs 100).

### 3.6 `cart.ts` (built; **Change**)

**Built:**

- `Cart` (version 1) with lines, `selectedKey`, `billDiscount`, `rxCheck`, `prescription`, `removed` and `undo`.
- `newCart`, `addItem` (a repeat scan merges into a plain line), `setQty`, `bumpQty`, `cycleUnit`, `removeLine` / `undoRemove`, `setLineDiscount`, `setBillDiscount`, `pickBatches`, `setPrice`, `selectLine`, `setRxCheck`, `setPrescription`, `toPricingLines`, `displayQty` and `defaultSaleUnit`.

**Changes:**

- `confirmedExpiredOnly` / `confirmExpiredOnly` become `confirmedInDate` / `confirmInDate`. `setQty`, `bumpQty` and `cycleUnit` clear the confirmation, because a larger quantity needs a new answer.
- `CartLine.packBatch: { batchNo; expiryDate; mrp: Money | null } | null`. It is only for controlled lines whose pack matches no recorded batch (D15).
- `MAX_LINE_QTY = 99_999` base units. `addItem` and `setQty` refuse larger quantities as a programming guard. The screen checks first with `lineQtyProblem(qty)`, which returns `'zero' | 'too_large' | null`. Because every 6-digit number is above the cap, a barcode in the Qty field can never be a quantity.
- `normalizeCart(cart) → { cart, dropped: { lineKey | null; reason }[] }` runs after every change and on resume. It drops a fixed line discount larger than the line's gross, a fixed bill discount larger than the discountable base, and a manual discount on a line that is no longer discountable. The screen shows "Discount removed — more than the new amount". Dropping is safer than clamping: clamping would make the line free.

### 3.7 `qty-input.ts` (built)

- `parseQtyInput`: `"3"` is 3 of the default unit, `"2s"`, `"1b 2s 5"`.
- `parseScanInput("2s*pana")` gives `{qtyText: '2s', term: 'pana'}`.
- `parseDiscountInput`: `"10"` / `"10%"` / `"12.5%"`; `"50/-"`, `"rs50"` or `"Rs 50"` is Rs 50; more than 100% is `'invalid'`.
- `looksLikeBarcode`: `/^\d{6,14}$/`.

### 3.8 `permissions.ts` (built; **Change**)

**Changes:** `clock.override` is replaced by `clock.reset`. `cost.view` is added. `APPROVABLE_PERMISSIONS` and `isApprovable` match the working tree, with `clock.reset` in place of `clock.override`. A snapshot test covers the table.

| Permission                                                               | Owner | Pharmacist | Cashier | Inventory | Approvable |
| ------------------------------------------------------------------------ | ----- | ---------- | ------- | --------- | ---------- |
| `sale.sell`                                                              | ✓     | ✓          | ✓       | –         | no         |
| `sale.price_override` (unused until it returns)                          | ✓     | ✓          | –       | –         | yes        |
| `sale.controlled`, `sale.void`, `sale.return`                            | ✓     | ✓          | –       | –         | yes        |
| `sale.return_late`                                                       | ✓     | –          | –       | –         | yes        |
| `sale.reprint`                                                           | ✓     | ✓          | ✓       | –         | no         |
| `drawer.no_sale`, `cash.pay_out_large`                                   | ✓     | ✓          | –       | –         | yes        |
| `shift.open`, `shift.close`, `cash.pay_in`, `cash.pay_out`, `backup.run` | ✓     | ✓          | ✓       | –         | no         |
| `shift.view_expected`                                                    | ✓     | ✓          | –       | –         | no         |
| `cost.view` (new)                                                        | ✓     | ✓          | –       | ✓         | no         |
| `catalog.edit`, `stock.adjust`, `import.run`                             | ✓     | ✓          | –       | ✓         | no         |
| `users.manage`, `settings.edit`, `backup.restore`, `audit.view`          | ✓     | –          | –       | –         | no         |
| `clock.reset` (replaces `clock.override`)                                | ✓     | ✓          | –       | –         | yes        |

- **Approval kinds:** `ApprovalKind = ApprovablePermission | 'sale.discount'`. A discount is a cap, not a permission. An approver qualifies when `effectiveCapBp(their role cap, default) ≥ need`.
- **Who may approve:** `rolesThatCan(p)` and `approverPhrase(roles)` ("a pharmacist or the owner").

### 3.9 `pin.ts` (built)

- **Hashing:** `hashPin(pin, iterations)`, `verifyPin`, and `hashSecret` / `verifySecret` for the recovery code.
- **PIN rules:** `pinProblem(pin, {owner})` gives `'format' | 'weak' | null`. Owners need 6 digits. Weak means one repeated digit or a run up or down.
- **Lockout:** `lockUntil(n, now)`: 5 failures lock for 1 min, 10 for 5 min, 15 and every 5 after for 15 min. `isLocked` ignores a lock more than 15 min ahead (the clock moved back).
- **Recovery code:** `generateRecoveryCode()` gives `7K4Q-9XMP-2RTD`; `normalizeRecoveryCode` cleans what the owner types.

### 3.10 `invoice.ts` (built)

- `formatDocNo('T1', 123)` = `'T1-000123'`; `formatDocNo('T1', 12, 'R')` = `'T1-R000012'`.
- `nextSeq(max, floor)`.
- `parseInvoiceQuery` reads `'123'`, `'t1 123'`, `'T1-000123'` and `'T1000123'`.

### 3.11 `clock.ts` (built; **Change**)

```ts
export function assessClock(
  now: Date,
  highWater: string | null,
  o: { buildTime: Date; warnBehindMs?: 600_000; aheadDays?: 3; latestYear?: 2035 },
):
  | { status: 'ok' }
  | { status: 'behind'; byMs: number }
  | { status: 'ahead'; days: number }
  | { status: 'implausible' };
export function effectiveToday(now, highWater, tz): IsoDate; // the later of the two local dates; used for EXPIRY only
export function laterTimestamp(a, b): string;
```

**Change:** `blockBehindMs` and `severity` are removed, so `'behind'` never blocks. `buildTime` comes from `ctx.buildTime` (§4.1).

**Example:** now is 2026-10-21 09:00Z and the high water is 2026-10-21 19:30Z (00:30 on the 22nd in Karachi).

- The clock is 10.5 h behind, so the banner shows.
- The sale's business date is `'2026-10-21'` (the PC's date).
- `effectiveToday` = `'2026-10-22'`, so a batch expiring on 21 Oct is blocked.

### 3.12 `backup-rules.ts` (built)

- **Names:** `backupFileName(at, kind, tz)` gives `'till-20261021-140500-auto.db'`, and `parseBackupFileName` reads it back.
- **When due:** `isBackupDue({okAt, outboxSeq}, now, currentSeq)`. It is due when there is no backup, when the last good one is over 24 h old, or when it is over 2 h old and the outbox has moved on. If the clock reads before the last backup, it backs up only new data.
- **Retention:** `selectBackupsToDelete(names)` works from the newest file, never from "now". It keeps:
  - everything within 48 h of the newest;
  - the newest per day for the 30 most recent days;
  - the newest per month for 12 months;
  - the 3 newest `premigrate` and 3 newest `prerestore` copies;
  - always the newest file.

  Names it can't parse are never pruned.

### 3.13 `approvals.ts` (new)

```ts
export type GrantKind = 'sale.discount' | 'sale.controlled' | 'sale.price_override';
export function grantScope(cart: Cart, kind: GrantKind, lineKey: string /* '' = bill */): string;
//  canonical JSON (sorted keys) of exactly what is approved:
//  sale.discount, line:   { line: { productId, qty, price, discount }, billDiscount }
//  sale.discount, bill:   { billDiscount, lines: [{ key, productId, qty, price, discount }, …] }
//  sale.controlled, '':   { lines: [{ key, productId, qty, batches, packBatch }, … controlled only], prescription }
//  sale.price_override:   { line: { productId, qty, price, reason } }   (when override returns)
export function grantCovers(
  g: { kind; lineKey; scopeJson; approvedBp; requestedBy },
  cart: Cart,
  actorId: string,
  d?: { discount: Money; gross: Money },
): boolean;
// the scope equals grantScope(cart, …), requestedBy = actorId, and for discounts
// discountWithinCap(d.discount − 1, d.gross, approvedBp): one more paisa because a bill share can move by a
// paisa when other lines change
```

- **When a line over its cap is covered:** a matching line grant, or a matching bill grant. A bill grant is invalidated by any change to any line, so it is asked for last, just before Pay.
- **Grants that no longer match** are ignored and can't cover anything else. They go away with the draft.

### 3.14 `apps/till/src/features/sale/scan-detector.ts` (to do)

`createScanDetector({minLength: 6, maxGapMs: 35}).key({key, timeStamp})` returns `{scan}` when 6 or more keys arrive at most 35 ms apart and end in Enter. The screen also treats any `looksLikeBarcode` value submitted from the Qty or discount field as a scan, so typing by hand is testable.

---

## 4. Services (`packages/db/src/services`)

### 4.1 Conventions

Each write follows this order:

1. `parseInput` (zod).
2. Async PIN and crypto checks **outside** the lock.
3. **One** `ctx.db.transaction()`.
4. `authorizeTx` first inside it.
5. Synced writes through `insertRow` / `updateRow`; local tables through plain Kysely.
6. `audit()`.
7. Return a view.

Never await crypto, Rust or printing inside a transaction.

- **`ServiceContext`** gains `pinIterations` (default `PIN_ITERATIONS`) and `buildTime` (default 2026-10-01). The working tree already has both.
  - The app passes `new Date(__BUILD_TIME__)`, set by a Vite `define` and declared in `apps/till/src/globals.d.ts`.
  - `vitest.config.ts` defines a fixed `__BUILD_TIME__` for app tests.
  - Code in `packages/*` never reads the global.
  - `createTestApp` passes `buildTime: 2026-10-01` and `pinIterations: 1000`.
- **Error mapping:** a `PricingError` or `RangeError` caused by input never escapes a service. Inputs are checked first, and anything left is mapped to `VALIDATION` with a field path.
- **Shared types:** `AppError` (with `details`) and `AuditEntry.approvedBy` are built. `Session` keeps its shape. `loadDevice(ctx) → {branchId, deviceId} | null` replaces `loadSession`; a user session comes only from `login`.

**Shared helpers** (`services/guards.ts`):

```ts
verifyApprover(ctx, a: { userId; pin }, need: ApprovalKind | { discountBp }): Promise<Approval>
// outside the tx: lockout, verifyPin; a wrong PIN counts against the approver; self-approval → FORBIDDEN
authorizeTx(trx, ctx, p, approval?): Promise<{ actor; approvedBy }>
// can() → ok; !isApprovable(p) → FORBIDDEN 'Only the owner can do this'; a valid approval (re-read: active, can()) → ok;
// else NEEDS_APPROVAL with details { permission }
requireOpenShiftTx(trx, ctx)                 // NO_SHIFT 'Open a shift before selling'
assertClockTx(trx, ctx)                      // CLOCK_WRONG only when implausible
noteClockSuspectTx(trx, ctx, shiftId)        // behind: audit clock.suspect once per shift
bumpClockTx(trx, ctx)                        // raises the high water, never lowers it
effectiveTodayTx(trx, ctx)                   // for expiry checks only; business dates use today(ctx)
expectedCashTx(trx, shiftId)
nextDocSeqTx(trx, ctx, 'sale' | 'return')
getStoreSettingsTx(db | trx, branchId)
grantsTx(trx, draftId): Promise<Grant[]>     // draft_approval rows, matched with grantCovers()
```

### 4.2 `auth.ts` and `users.ts` (in progress in the working tree)

- **`setupStore(ctx, {...M1 fields, ownerPin, ownerPinRepeat})`** → `{session, recoveryCode}`. It stores `recovery_hash` and audits `store.setup`.
- **`setInitialOwnerPin(ctx, {pin})`** → `{recoveryCode}`. Only while the owner's `pin_hash IS NULL` (an M1 database). Audits `auth.pin_set`.
- **`listLoginUsers(ctx)`** → active users as `{id, name, role, hasPin, lockedUntil}`.
- **`login(ctx, {userId, pin})`** → `Session`:
  1. Locked → `LOCKED` 'Too many wrong PINs. Try again at 14:10'.
  2. `verifyPin` runs outside the transaction.
  3. Wrong PIN: in a small transaction, add one to `failed_count` and set `locked_until`; audit `auth.lockout` when it newly locks; throw `WRONG_PIN` with `fields.pin` 'Wrong PIN — 2 tries left'.
  4. Correct PIN: delete the attempt row, delete the active draft's grants requested by anyone else, and audit `auth.login`. Login does **not** raise the clock high water.
- **`logout`** audits `auth.logout`. **`changeOwnPin`** audits `auth.pin_change`. **`resetOwnerPinWithRecovery`** rotates the code, clears the lockout and audits `auth.recovery_used`.
- **User management** needs `users.manage`, which can't be approved:
  - `createUser`, `updateUser` (refuses to demote or deactivate the last active owner, and refuses deactivating yourself), `resetUserPin` and `unlockUser`, each audited.
  - No PIN hash is ever audited.
- **`grantApproval(ctx, {draftId, kind, lineKey, userId, pin})`** → `{approverName, approvedBp}`:
  1. The screen flushes the draft first.
  2. Load the saved active draft, run `normalizeCart`, and compute the need **in the service**. For `sale.discount` that is `discountNeedBp` for the line, or the maximum over lines for a bill grant. The client never sends `needBp`.
  3. `verifyApprover(need)`, outside the transaction.
  4. In a transaction:
     - re-check the approver (active, can or cap);
     - upsert `draft_approval` with `scope_json = grantScope(cart, kind, lineKey)`, `approved_bp = need` (not the approver's cap) and `requested_by = ctx.session.userId`;
     - audit `auth.approval` `{kind, lineKey, approvedBp}` with `approvedBy`.

### 4.3 `settings.ts` (in progress)

`getStoreSettingsTx` overlays the `setting` rows on `CHECKOUT_DEFAULTS`. Each key is checked with zod; a bad row falls back to the default and is logged.

| Setting              | Default                                                |
| -------------------- | ------------------------------------------------------ |
| `rounding`           | `{step: 100, mode: 'nearest'}`                         |
| `defaultDiscountBp`  | 0                                                      |
| `discountCapBp`      | owner 10000, pharmacist 1500, cashier 500, inventory 0 |
| `defaultSaleUnit`    | `'strip'` (or `'base'`)                                |
| `saleNearExpiryDays` | 30                                                     |
| `rxCheck`            | `'record'` (or `'require_seen'`)                       |
| `returnDays`         | 7                                                      |
| `payOutLimit`        | 200000                                                 |
| `varianceNoteAt`     | 10000                                                  |
| `defaultFloat`       | 500000                                                 |
| `autoLockMinutes`    | 5                                                      |
| `maxHeld`            | 10                                                     |
| `receipt`            | `{showBatch: true, showSavings: true, footer: []}`     |

- **`updateStoreSettings(ctx, patch)`** needs `settings.edit`. Every cap must be at least the default. It audits `settings.update` with before and after.
- **Device settings** (`local_meta.device_settings`; `settings.edit`; audited `settings.device`):
  - `printer: {mode: 'off' | 'windows' | 'network', printerName: null /* Windows default */, host, port: 9100, columns: 48 | 42 | 32, cut: true, autoPrint: true}`. The mode defaults to `'off'`.
  - `drawer: {enabled: false, pin: 2 | 5}`.
  - `backup: {mirrorDir: null}`.

### 4.4 `shift.ts`

- **`getOpenShift(ctx)`** → `OpenShift | null`, with `stale` set when it was opened more than 18 h ago.
- **`openShift(ctx, {openingFloat, count?, confirmDate?})`** needs `shift.open`. One transaction:
  1. `assertClockTx` (implausible blocks). When the clock is `ahead`, `confirmDate` must equal today; it is audited `clock.date_confirmed`.
  2. An open shift already exists → `INVALID_STATE`.
  3. `shift_no` = MAX + 1, and `business_date = today(ctx)`.
  4. `insertRow` the shift and audit `shift.open`. A float different from the last shift's `float_left` also audits `shift.float_mismatch`.
  5. `noteClockSuspectTx`, then `bumpClockTx`.
- **`recordCashMovement(ctx, {kind, category, amount > 0, note, approval?})`** needs `cash.pay_in` or `cash.pay_out`, plus `cash.pay_out_large` above the limit.
  - A pay-out above expected cash fails on `fields.amount`. With `shift.view_expected` the message is 'Only Rs 1,240.00 should be in the drawer'; without it, 'Not enough cash in the drawer for this pay-out', with **no amount**.
  - It inserts the signed row, audits with `approvedBy` and returns `{openDrawer: true}`.
- **`recordNoSale(ctx, {reason, approval?})`** needs `drawer.no_sale` and audits it.
- **`getShiftTotals(ctx, shiftId)`** comes from the records only:
  - payments by method and `doc_type`, and wallet totals by provider;
  - cash movements by category;
  - sales excluding voided ones: count, gross, discounts, rounding, tax and cost;
  - voids and returns;
  - counts of above-MRP, unrecorded-stock, expired-on-record and Rx-not-seen lines;
  - held drafts, and whether the clock was suspect.

  For an actor without `shift.view_expected`, the **service** returns `expectedCash: null` and `variance: null` until the shift has a `shift.count` audit.

- **`closeShift(ctx, {shiftId, countedCash, count?, floatLeft, note?})`** needs `shift.close` and runs in two phases. In one transaction:
  1. An active draft with lines → `INVALID_STATE` 'Hold or finish the sale in progress'.
  2. Expected cash is computed inside the transaction. If `count` is given, its total must equal `countedCash`.
  3. If |variance| ≥ `varianceNoteAt` and there is no note: audit `shift.count` (committed) and return `{status: 'needs_note', variance}`.
  4. `floatLeft` must be ≤ counted.
  5. `updateRow` closes the shift; audit `shift.close`; `bumpClockTx`.

  It returns `{status: 'closed', totals}`. The UI then runs the `shift` backup and shows the Z report.

### 4.5 `drafts.ts` (local-only)

- **`startDraft(ctx)`** → the active draft, inserting an empty one (`line_count 0`, `total 0`) when the till has none. The screen calls it on entry and after completing, holding or discarding.
- **`saveDraft(ctx, cart)`** is one autocommit statement:

  ```sql
  UPDATE sale_draft SET cart_json = ?, line_count = ?, total = ?, updated_at = ?
  WHERE id = ? AND device_id = ?
  ```

  - It returns `{saved: boolean}`; 0 rows means the draft was completed or discarded, and the screen ignores it.
  - `total` comes from `priceSale` on the normalised cart; if pricing still fails, it stores 0 (the held list only).
  - It never inserts a row or writes `status`.

- **`getActiveDraft(ctx)`** is checked with zod. An unknown cart version is held with a notice.
- **`holdDraft(ctx, {draftId, label?})`** allows at most `maxHeld` and **deletes the draft's grants**. **`listHeldDrafts(ctx)`** lists held sales.
- **`resumeDraft(ctx, {draftId})`** runs in one transaction: the current active draft is held if it has lines (an empty one is deleted), and the target becomes active.
- **`discardDraft(ctx, {draftId})`** audits `sale.draft_discard` `{lines, total, removed}` when the draft has lines.

### 4.6 `checkout.ts`

**Reads:**

- **`getSellable(ctx, productId)`** returns the product snapshot (units, price, `allowDiscount`, tax rate, Rx and schedule) and batches with stock, expiry status (by `effectiveTodayTx`), MRP and the placeholder flag. `cost` is included only when the actor has `cost.view`.
- **`findByScan(ctx, code)`** reuses `findProductByBarcode`; product search uses `searchProducts`.

**`planSale(ctx, {draftId, cart})`** is read-only and shares `buildSaleTx` with `completeSale`.

- It returns priced lines with allocations, totals, `warnings[]`, `needs[]` (approvals not covered by a matching grant) and `blockers[]`.
- Warning kinds: `past_zero`, `expired_on_record`, `above_mrp`, `near_expiry`, `rx`, `controlled`, `price_changed`, `discount_dropped`, `approval_stale`, `clock_behind`.

**`completeSale(ctx, {draftId, tenders, expectedTotal})`** reads the cart from the draft row and runs as **one `BEGIN IMMEDIATE` transaction**:

1. If a sale with `id = draftId` exists, return it with `alreadyCompleted: true`. Otherwise the active draft must exist ('This sale is no longer open').
2. `authorizeTx('sale.sell')` (FORBIDDEN for inventory), `assertClockTx`, `requireOpenShiftTx`. Then `businessDate = today(ctx)`, `expiryToday = effectiveTodayTx`, and the settings.
3. **Validate before pricing.** Any failure is a `VALIDATION` error on the field shown:

   | Problem                                                                             | Field and message                                                                  |
   | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
   | Product inactive                                                                    | `lines.i.productId` 'Archived — ask the owner'                                     |
   | Unit not sellable                                                                   | `lines.i.qty`                                                                      |
   | Quantity is 0 or more than 99,999 base units                                        | `lines.i.qty` 'At most 99,999 Tablets on one line'                                 |
   | Manual batch foreign, unknown or expired                                            | `lines.i.batches.j.batchId` 'Batch AU0900 expired on 30 Sep 2026 — cannot be sold' |
   | Picks don't add up to the quantity                                                  | `lines.i.batches`                                                                  |
   | Controlled line with neither picks nor a typed pack batch                           | `lines.i.batches`                                                                  |
   | Typed pack batch is not on a controlled line, or its expiry is before `expiryToday` | `lines.i.packBatch.expiryDate`                                                     |
   | Manual discount on a non-discountable line                                          | `lines.i.discount` 'No discount on this item'                                      |
   | Fixed discount above the line amount                                                | `lines.i.discount` 'More than the line amount'                                     |
   | Fixed bill discount above the discountable total                                    | `billDiscount`                                                                     |
   | `priceSource 'override'`                                                            | `NOT_AVAILABLE` 'Price changes come later — sell at the catalog price or MRP'      |

4. **Allocate** each line over a working copy of the lots. A line with `needsConfirm` and no `confirmedInDate` → `NEEDS_CONFIRMATION` with `details.lines` `[{key, inDate, shortfall, expiredQty, expiredBatches}]`.
5. **Prices:** `catalog` is the current product price; `mrp` is the lowest MRP among the line's allocations.
6. **`priceSale`.** A `PricingError` (which should be unreachable) becomes `VALIDATION`. If `total ≠ expectedTotal` → `TOTAL_CHANGED` 'The total is now Rs 1,972.00 — check the bill', with `details.lines`.
7. **Discounts:** for each line, d = lineDiscount + billShare. When `discountWithinCap(d, gross, effectiveCapBp(actor cap, default))` fails, a grant that `grantCovers` (line or bill, `requestedBy = actor`) must exist. Otherwise → `NEEDS_APPROVAL` with `details {kind: 'sale.discount', lineKey, needBp, lines}`.
8. **Rx and controlled:**
   - Rx lines need `cart.rxCheck`. Under `'require_seen'`, `not_seen` fails on `fields.rxCheck`.
   - Controlled lines need `prescription.patientName` and `prescriberName`.
   - The dispenser is the actor if they have `sale.controlled`. Otherwise a covering `sale.controlled` grant is needed, and **its approver** is the dispenser.
9. **`settleTenders`.** Problems go to `fields.tenders.i.amount` or `.reference` ('Rs 120.00 still to pay'). Khata → `NOT_AVAILABLE`. A total of 0 needs no tenders.
10. **Number, placeholder and pack batches:**
    - `seq = nextDocSeqTx('sale')` and `invoice_no = formatDocNo(device.code, seq)`.
    - Get or create the placeholder batch (`insertRow batch`, `is_placeholder 1`, `batch_no ''`, no expiry, `pack_qty` = the price unit, source `'adjustment'`).
    - For each `packBatch`, reuse a batch of the product with the same `batch_no` and expiry, or `insertRow` a real one: source `'adjustment'`, typed expiry and MRP, no cost.
11. **`insertRow`**, in this order:
    - the `sale`;
    - each `sale_line`;
    - for each part, a `stock_movement` (`kind 'sale'`, qty −q, ref `('sale', sale.id)`, reason 'Sold without recorded stock' for unrecorded parts), then its `sale_line_batch`;
    - the `payment` rows (none when the total is 0);
    - the `sale_prescription`, if any.
12. **Audits,** only when they apply:
    - `sale.discount` (with `approvedBy`), `sale.above_mrp`, `sale.past_zero`;
    - `sale.expired_on_record` `{inDate, shortfall, expiredQty, batches}`, `sale.rx_not_seen`;
    - `sale.controlled` `{schedule, prescriptionId, dispensedBy, packBatchCreated}`, `sale.lines_removed`;
    - `noteClockSuspectTx`.
13. When printing is on with auto-print, write `local_meta.last_receipt` = `{docType: 'sale', docId, status: 'pending'}`.
14. Delete the draft (its grants cascade) and run `bumpClockTx`.

It returns `{saleId, invoiceNo, total, change, cashReceived, alreadyCompleted, openDrawer: cashReceived > 0, receipt}`. Printing and the drawer happen **after** the commit.

**`voidSale(ctx, {saleId, reason, approval?})`** needs `sale.void` (approvable). One transaction:

- **Refusals:** the sale must be in the open shift ('This sale is from a closed shift — use a return'), not voided, and have no returns.
- **Writes:**
  - an `insertRow` of `sale_void`;
  - for each allocation, a `stock_movement` with `kind 'sale_return'`, +q, ref `('sale_void', voidId)` and the same batch;
  - for each original payment, a `payment` with `doc_type 'void'`, the same method, provider and reference, and amount −p;
  - audit `sale.void` with `approvedBy`;
  - `last_receipt` when printing is on;
  - `bumpClockTx`.
- **Returns** `{cashToGiveBack, nonCash, openDrawer}`.

**Other reads and actions:** `getSale`, `findSale(text)`, `listSales({shiftId?, date?, query?, limit})`, `getLastSale`, and `recordReprint(ctx, {saleId})` (`sale.reprint`; audited; marked REPRINT).

### 4.7 `returns.ts` (M2b)

**`getReturnableSale(ctx, saleIdOrInvoice)`** returns, per line: sold, returned and returnable quantities, and what is left per allocation. It also returns refund limits per method, the days since the sale and whether a late approval is needed. A voided sale → `INVALID_STATE`.

**`createReturn(ctx, {saleId, lines: [{saleLineId, qty, restock}], reason, note?, refunds: Tender[], approval?, expectedRefund})`** runs in one transaction:

1. `authorizeTx('sale.return')`, plus `sale.return_late` past `returnDays`, plus `sale.controlled` for controlled lines. One approver must cover everything needed.
2. Open shift; the sale is not voided. Each `qty ≤ returnable` (`lines.i.qty` 'Only 1 Strip, 2 Tablets left to return').
3. **Amounts:**
   - `splitReturnQty` picks the allocations, last first.
   - Line refund and tax use `refundShare` on the line, then are split over the pieces by `allocateProRata(…, qtys)`.
   - Cost uses `refundShare` per allocation.
   - Restock is forced to 0 when the batch has expired by `effectiveTodayTx`.
4. **`refundTotal`** (exact on the final return). It must equal `expectedRefund`, else `TOTAL_CHANGED`.
5. **Refund methods:**
   - The refunds must add up to the refund total.
   - Card and wallet are each capped at what was paid that way minus what was already refunded.
   - Cash may be used for any refund, but not more than expected cash. Without `shift.view_expected`, the message is 'Not enough cash in the drawer for this refund' (no amount).
   - A sale that totalled 0 has nothing to refund.
6. `seq = nextDocSeqTx('return')` gives `return_no`.
7. **`insertRow`**, in this order: the `sale_return`; for each piece, a movement when restocked, then the `sale_return_line`; then the negative `payment` rows.
8. Audit `sale.return` with `approvedBy`; `last_receipt` when printing is on; `bumpClockTx`.

### 4.8 `clock.ts`

- **`getClockStatus(ctx)`** → `assessClock(...)` plus the high water.
- **`resetClockGuard(ctx, {approval?})`** needs `clock.reset` (approvable). It is allowed when the clock is `behind`. It sets the high water to now and audits `clock.reset` `{from, to}`.

| Clock reading   | What happens                                                                                                                                                                                                                     | Who fixes it                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implausible     | Blocks shifts and documents: "The computer's date (1 Jan 2009) can't be right. Ask the owner to set the date and time in Windows (Settings → Time & language → Date & time)". The block lifts by itself once the clock is right. | Whoever has the Windows administrator password, usually the owner. A standard Windows account can't change the time.                                                                           |
| Behind > 10 min | Banner; selling continues; `clock.suspect` once per shift                                                                                                                                                                        | **PC clock wrong:** fix the Windows time. **PC clock right** (an earlier forward jump): a pharmacist or the owner presses [The clock is right — reset]; a cashier asks for a pharmacist's PIN. |
| Ahead > 3 days  | Confirm the date at Open shift                                                                                                                                                                                                   | Whoever opens the shift                                                                                                                                                                        |

### 4.9 `backup.ts`

The `BackupPort` sits over the existing Rust commands: `apps/till/src/platform/backup-port.ts` on desktop, a fake in tests, and `null` in the browser ("Backups run in the desktop app").

```ts
interface BackupPort {
  create(name: string): Promise<BackupCheck>; // backup_create
  verify(name: string): Promise<BackupCheck>; // backup_verify
  list(dir?: string): Promise<BackupFile[]>; // backup_list
  remove(name: string, dir?: string): Promise<void>; // backup_delete
  copyTo(name: string, destDir: string): Promise<void>; // backup_copy (M2b)
  checkFolder(dir: string): Promise<void>; // folder_check (M2b)
  restore(name: string, safetyName: string): Promise<void>; // backup_restore (screen in M5)
}
// BackupCheck exactly as Rust returns it: { name, sizeBytes, integrityOk, integrity, migrations,
//   saleCount, lastSaleAt, outboxSeq }
```

**`runBackup(ctx, port, kind)`** → `{ok, name, message?}`. It **never throws into a sale flow**.

1. Skip when the clock is implausible, because the names come from the clock.
2. Note `seqBefore = MAX(sync_outbox.seq)`.
3. `port.create(backupFileName(now, kind, tz))`. The copy is good only if `integrityOk` and `outboxSeq ≥ seqBefore`.
4. Copy to the mirror folder if one is set (M2b).
5. Write a `backup_log` row.
6. Prune with `selectBackupsToDelete` over `port.list()`. Pruning is skipped when the clock is not ok.

A manual run needs `backup.run`.

**Pre-migration backup:** `openDatabase(executor, {beforeMigrate})` calls the hook only when migrations are pending and `schema_migration` already has rows.

- On desktop the hook runs `port.create(…premigrate…)` and keeps the result in memory.
- Boot writes its `backup_log` row **after** `migrate()` finishes, because `backup_log` is created by 0002.
- If the backup fails, the boot screen offers [Try again] and [Continue without a backup], and the failed row is logged after migration.

**`backupStatus(ctx)`** → `{lastOk, overdue (> 26 h), mirrorOverdue (> 3 days, M2b)}`.

**Restore (M5):**

- **`prepareRestore`** needs `backup.restore`. It refuses unknown migrations and returns what would be lost and the old maximum invoice and return numbers.
- **`restoreBackup`** checks the owner PIN, then calls `port.restore(name, backupFileName(now, 'prerestore'))`; the Rust safety copy is the prerestore backup.
- **`afterRestoreTx`** runs at boot when the marker is present and is idempotent: `invoice_floor = max(floor, oldMax + 1, or restoredMax + 1000)`, the same for returns, audit `backup.restore`, `bumpClockTx`, and mark `last_receipt` skipped.

### 4.10 `receipt-data.ts`

`getSaleReceiptData(ctx, saleId, {copy})`, `getReturnReceiptData`, `getVoidSlipData` and `getShiftReportData` map rows to plain data. The receipt label for `sale.gross_total` is **"Items total"**; `subtotal` is never printed under that name.

### 4.11 Audit viewer

The audit-log viewer (`listAudit` and its screen) is **M4**. M2 records every action in §4.14.

### 4.12 Changes to M1 services

- **Permission checks** (non-approvable, so FORBIDDEN): `catalog.edit` on product writes, `stock.adjust` on opening stock and adjustments, `import.run` on imports.
- **Already built:** `allowDiscount` in `productInputSchema` and the product writes; placeholders in the stock views and excluded from `planFefo`.
- **Product form and import:** the form gets the Allow-discount checkbox and the import an optional column.
- **Cost:** `getProduct` and `getProductStock` drop cost fields for roles without `cost.view`. They take `AppContext`, which callers already have.
- **`createTestApp()`** sets an owner PIN (1,000 iterations), logs in and passes `buildTime`. It adds `asRole(t, role)`, `openTestShift(t, float = 500000)` and `stockBatches(t, productId, …)`.

### 4.13 `integrity.ts` (test helper in M2; the Health screen uses it in M5)

`checkRecords(db)` → `RecordProblem[]`, which should always be empty. It checks:

- The stock cache matches the ledger (`findStockCacheMismatches`).
- Each sale header equals the sum of its lines, and Σ of its sale payments equals its total. A sale with total 0 has no payments; the empty sum is 0.
- Allocations add up to each line's quantity, and each allocation's movement matches its batch, quantity, kind and ref.
- Void payments and movements are the exact reversal of the sale's.
- Return lines add up to their header, return payments equal −`refund_total`, and restocked lines have their movement.
- Σ refunds ≤ the sale total, and equal it when the sale is fully returned.
- No document landed in a shift after it closed.
- Each closed shift's `expected_cash` equals the recomputed figure.
- Invoice numbers have gaps only at recorded floors.
- Every synced row has its outbox insert.

### 4.14 Audit actions (`entity_type` / `entity_id` are the document)

| Area               | Actions                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| auth               | `auth.login`, `auth.logout`, `auth.lockout`, `auth.pin_set`, `auth.pin_change`, `auth.pin_reset`, `auth.recovery_used`, `auth.unlock`, `auth.approval`                                                       |
| users and settings | `user.create`, `user.update`, `user.role_change`, `user.deactivate`, `settings.update`, `settings.device`                                                                                                    |
| shift and cash     | `shift.open`, `shift.float_mismatch`, `shift.count`, `shift.close`, `cash.pay_in`, `cash.pay_out`, `drawer.no_sale`                                                                                          |
| sale               | `sale.discount`, `sale.above_mrp`, `sale.past_zero`, `sale.expired_on_record`, `sale.rx_not_seen`, `sale.controlled`, `sale.lines_removed`, `sale.draft_discard`, `sale.reprint`, `sale.void`, `sale.return` |
| clock and backup   | `clock.suspect`, `clock.date_confirmed`, `clock.reset`, `backup.restore` (M5)                                                                                                                                |

---

## 5. UI (`apps/till`)

**Conventions:**

- All text goes in `strings.ts`. New sections: `S.login`, `S.lock`, `S.shift`, `S.cash`, `S.sale`, `S.pay`, `S.hold`, `S.batch`, `S.returns`, `S.receipt`, `S.users`, `S.settings`, `S.backup`, `S.clock`.
- Forms use `Field` + `TextInput` / `Select`.
- Writes use `useAction`, **except** draft saves and `planSale` (a debounced `useQuery` keyed by a cart hash).
- `Services` gains `user {id, name, role}`; login and lock swap `ctx.session`.
- **The draft flush:** one `flushDraft()` cancels the debounce and awaits `saveDraft`. It runs before Pay completes, hold, resume, discard, any approval dialog and lock.

### 5.1 Boot and recovery

1. Open the database. On desktop, a pending migration on an existing database runs the `premigrate` backup first (§4.9).
2. If the database can't open: "The till could not start: <reason>". The screen shows the backups folder. [Restore from a backup] arrives in M5.
3. `loadDevice`. With no device, Setup asks for the owner PIN twice, then shows "Write down this recovery code" with a required tick. An M1 database whose owner has no PIN goes to "Set the owner PIN" first.
4. Login.
5. Clock: implausible → full-screen block (§4.8); behind → amber banner, with [The clock is right — reset] for a pharmacist or the owner.
6. Notices, each shown once:
   - "The sale in progress was restored (3 items)".
   - "Receipt for T1-000123 may not have printed — [Print] [Skip]", from `last_receipt` (M2b).
   - "Shift 11 started yesterday and is still open — [Close it] [Keep selling]".
7. No open shift and a selling role → the Open shift card. The float is prefilled from the last `float_left` (or Rs 5,000), and the date is confirmed if the clock is ahead. Enter opens the shift. Then the Sale screen, which `startDraft`s.

### 5.2 Login, lock and approvals

- **Login:** tiles of active users (arrows and Enter, or click), then the PIN field and Enter.
  - Errors: "Wrong PIN — 2 tries left" / "Locked until 14:10".
  - A "Forgot owner PIN?" link uses the recovery code.
- **Lock:** Ctrl+L or the idle timer flushes the draft and locks: "Locked — Ali was using the till". Anyone can unlock and the cart continues. Approvals given while someone else was selling no longer apply, and the screen says so.
- **Approval dialog** (shared, opened by `NEEDS_APPROVAL`): "Needs a pharmacist or the owner — 11.8% on Augmentin 625mg (your limit 5%)".
  - Only qualifying users are listed; enter the PIN, then Enter.
  - For draft-bound kinds it calls `grantApproval` after a flush. Otherwise the action is retried with `approval`.
  - A toast says "Approved by Sana". A line that changes afterwards shows "Approval no longer covers this — ask again".

### 5.3 Sale screen (`#/sale`, the default route; 1366×768)

```
┌ Shifa Pharmacy · Till T1 · Shift 12 since 09:02 │ Printing off — receipts on screen │ Backup ✓ 14:00 │ Held 2 │ Ali (Cashier) │
├──────────────────────────────────────────────────────────────┬─────────────────────────────────┤
│ [ Scan or type a medicine — 2s*name or 3*barcode       ]      │ 4 items                         │
│  ┌ dropdown (8 hits): name · salts · stock · rack · Rx/B ┐   │ Items total          2,045.29   │
│  │ [Tablet 72.70] [Strip 436.20] [Box 1,308.60]  ←/→ unit │   │ Item discounts         -58.16   │
├──────────────────────────────────────────────────────────────┤ Bill discount 2%       -21.74   │
│ # Item                    Qty                 Price      Disc  Amount │ Rounding            -0.39   │
│ 1 Panadol 500mg           2 Strips      245.00/Strip    —    490.00 │ TOTAL                       │
│   PN01 · Jun 2027                                                    │   Rs 1,965.00 (44px)        │
│▌3 Augmentin 625mg [Rx]    1 Strip, 2 Tablets 436.20/Strip 10% 523.44 │ [F9 Pay]  [F8 Hold]          │
│   AU1123 · Mar 2027                                                  │ Last: T1-000122 · change 60  │
├ F1 Help · F2 Find · F4 Batch · F6 Disc · Shift+F6 Bill disc · F8 Hold · F9 Pay · Del Remove · Ctrl+L Lock ┤
```

- **Above MRP:** before its 10% discount, line 3 showed the amber chip "Above MRP 415.00/Strip — Alt+M": its net 581.60 was above the MRP of 553.33 for 8 tablets. The discount brought it to 523.44, and the chip cleared.
- **Layout:** the lines grid uses `role="grid"` and `aria-selected`; totals are `aria-live="polite"`. At 1024×640 the Disc column hides.
- **Chips:** amber for "Above MRP", "Stock shows 5 — selling 20" and "Expires 12 Nov (22 days)"; blue for "Rx"; purple for "Sched B"; grey for "AU1123 (picked)".

### 5.4 Keys

A capture-phase handler calls `preventDefault` on F1–F12, Ctrl+F/G/H/J/P/R/S/U/D/K, Ctrl+±/0 and Alt+←/→. Every action also has a button.

| Where          | Key                                        | Action                                                                                                                                                                                   |
| -------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anywhere       | F1 / Ctrl+L / Esc                          | Help / lock / close the dialog and return to the scan box                                                                                                                                |
| Anywhere       | Alt+1 / 2 / 3 / 4 / 5 / 9                  | Sale / Sales & returns / Products / Stock / Shift / Settings                                                                                                                             |
| Scan box       | Typing, Enter                              | An exact barcode adds that pack at once, however slowly it was typed. Otherwise Enter adds the highlighted hit in the highlighted unit (default Strip). A repeat scan adds one more.     |
| Scan box       | `3*code`, `2s*pana`, `3t*brufen`           | Quantity prefix                                                                                                                                                                          |
| Scan box empty | ↑ / ↓, Enter                               | Select a line / edit its quantity (quick quantity, preview "= 1 Strip, 2 Tablets")                                                                                                       |
| Scan box empty | + / − (numpad), Delete, Ctrl+Z             | One unit more / less; remove the line (logged); undo within 10 s                                                                                                                         |
| Scan box empty | F4 (M2b) / F6 / Alt+M                      | Batch picker / line discount / sell at MRP                                                                                                                                               |
| Sale           | Shift+F6 / F8 / Shift+F8 / F9              | Bill discount / hold / held sales / pay                                                                                                                                                  |
| Sale           | Ctrl+P / Alt+C / Alt+D / Ctrl+Shift+Delete | Reprint last / cash in-out / no-sale drawer / clear the sale (confirm, audited)                                                                                                          |
| Pay dialog     | Enter, F9 again                            | Complete; exact cash                                                                                                                                                                     |
| Pay dialog     | Alt+K / Alt+W / **Alt+Y / Alt+N**          | Add a card row / add a wallet row / prescription seen / not seen. Plain Y and N work only while the Rx choice has focus, so typing "Nadia" or a Raast reference can't change the answer. |

**Scans in other fields:**

- **Qty or discount field:** a fast burst, or any 6–14-digit value submitted with Enter, gives the field its old value back and adds the item.
- **Pay dialog:** a burst is ignored ("Scan ignored — finish payment first (Esc)"). A barcode typed slowly into the cash field triggers the large-tender confirmation. A barcode can never become a tender.

### 5.5 Warnings and blocks

| Situation                                                 | What the cashier sees                                                                                                                                                                                                                                                                                                               | Blocks?                      | Recorded                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| Above MRP                                                 | Amber chip; listed in Pay; Alt+M sells at MRP                                                                                                                                                                                                                                                                                       | No                           | `above_mrp` + audit            |
| Past zero stock                                           | Amber chip "Stock shows 5 — selling 20"                                                                                                                                                                                                                                                                                             | No                           | Unrecorded part + audit        |
| Beyond in-date stock with expired stock on record         | Dialog. **All expired:** "All recorded stock of Panadol is EXPIRED (PN-00, Sep 2026). Sell only if the pack in hand is in date." **Some in date:** "Stock shows 5 in date; 20 more are EXPIRED (PN-00, Sep 2026). Sell the other 5 only if the packs in hand are in date." Buttons: [In date — sell (Enter)] [Sell only 5] [Remove] | Confirm                      | `sale.expired_on_record`       |
| Expired batch picked                                      | The row is disabled ("Expired — cannot be sold"); service and trigger refuse it                                                                                                                                                                                                                                                     | **Yes**                      | —                              |
| Near expiry (≤ 30 days)                                   | Amber chip with the date                                                                                                                                                                                                                                                                                                            | No                           | —                              |
| Rx line                                                   | Alt+Y / Alt+N in Pay                                                                                                                                                                                                                                                                                                                | No (setting)                 | `rx_check` + audit if not seen |
| Controlled (Schedule B/D)                                 | Batch picker (or the batch typed from the pack), prescription form, pharmacist PIN if needed                                                                                                                                                                                                                                        | **Yes** until done           | `sale_prescription` + audit    |
| Discount over cap                                         | Approval dialog                                                                                                                                                                                                                                                                                                                     | **Yes** until approved       | Audit with approver            |
| Approval no longer matches                                | Chip "Approval no longer covers this — ask again"                                                                                                                                                                                                                                                                                   | **Yes** until approved again | —                              |
| Discount dropped by a quantity change                     | Toast "Discount removed — more than the new amount"                                                                                                                                                                                                                                                                                 | No                           | —                              |
| Unknown barcode                                           | Toast "No product with barcode 896… — F2 to search"                                                                                                                                                                                                                                                                                 | —                            | —                              |
| Archived product                                          | Red toast                                                                                                                                                                                                                                                                                                                           | **Yes**                      | —                              |
| No shift                                                  | Open-shift card, one Enter                                                                                                                                                                                                                                                                                                          | One Enter                    | —                              |
| Clock implausible                                         | Full screen with the steps to fix it                                                                                                                                                                                                                                                                                                | **Yes**                      | —                              |
| Clock behind > 10 min                                     | Amber banner (+ reset for a pharmacist or the owner)                                                                                                                                                                                                                                                                                | No                           | `clock.suspect` once per shift |
| Clock > 3 days ahead                                      | Confirm the date at Open shift                                                                                                                                                                                                                                                                                                      | One Enter                    | `clock.date_confirmed`         |
| Large tender (> due + Rs 5,000, or > 10× and Rs 100 over) | "Received Rs 50,000 for a Rs 1,965 bill? Enter to confirm"                                                                                                                                                                                                                                                                          | Confirm                      | —                              |
| Total 0                                                   | "Nothing to pay — Enter to finish"                                                                                                                                                                                                                                                                                                  | No                           | Discount audit as usual        |
| Printing off / no drawer                                  | Status bar; "Open the drawer by hand" after a cash sale                                                                                                                                                                                                                                                                             | No                           | —                              |
| No backup for 26 h                                        | Amber badge                                                                                                                                                                                                                                                                                                                         | No                           | —                              |

### 5.6 Pay (F9)

1. **Open:** Pay flushes the draft. A 560px dialog shows "TOTAL Rs 1,965.00" in 48px type and a strip of warnings ("1 line above MRP · 1 unrecorded").
2. **Prescriptions:**
   - Rx lines add a "Prescription seen?" choice: Alt+Y / Alt+N, or Y/N while it has focus.
   - Controlled lines add Patient, Phone, Prescriber, PMDC no., Rx date and Rx ref, plus the pharmacist PIN when the seller is a cashier.
   - **One prescription per sale.** Items from a second prescription are rung up as a second sale; the dialog says so when a second prescriber is needed.
   - Enter stays disabled until these are filled.
3. **Cash:** cash is focused, with `suggestCash` buttons underneath. Enter on an empty field means exact cash. With a total of 0 there are no tender fields: "Nothing to pay — Enter to finish".
4. **Other tenders:**
   - Alt+K adds a card row: the amount is prefilled to the remainder, with an optional approval code.
   - Alt+W adds a wallet row: J / E / R / O for the provider, the amount, a **required** transaction ID of at least 4 characters, and the tick "Money received — I checked the app/SMS".
   - Khata is greyed out: "Comes with customer accounts".
5. **Live totals and errors:** "Remaining / Change" updates in large type. Errors appear on their fields. `TOTAL_CHANGED` reloads the prices, marks the changed lines and asks again. `NEEDS_APPROVAL` opens the approval dialog.
6. **Done panel:**
   - "CHANGE Rs 35.00" in 80px type, "Invoice T1-000123", and the receipt preview (`data-testid="receipt-preview"`, monospace, at most 48 columns).
   - Print status: "Printing is off — receipt shown on screen", "Printed", or "Receipt not printed: printer at 192.168.1.50 not answering [Retry]".
   - Any key starts the next sale, and that key lands in the scan box.

### 5.7 Hold, batch picker, discounts

- **Hold:**
  - F8 flushes, asks for an optional label (Enter skips) and shows "Held #2 · Rs 1,965". Held sales lose their approvals.
  - Shift+F8 lists held sales (label, items, total, age, who held it). Enter resumes, and Delete discards (confirm, audited).
  - Resuming while a cart is in progress holds that cart first. On resume, `normalizeCart` and `planSale` flag changed prices, newly expired batches and dropped discounts.
- **Batch picker (F4, M2b):**
  - The first row is "Automatic (first to expire)". Then one row per batch: batch no., expiry (coloured), days left, on hand, MRP, and cost (only with `cost.view`).
  - Typing filters by batch no. Expired rows are disabled. Short stock shows "Only 4 in stock — stock will show −6".
  - When no batch can be sold, a non-controlled line offers "Not in the list (unrecorded stock)". A controlled line instead offers "Not in the list — type the batch from the pack" (batch no., expiry, optional MRP; an expired date is refused).
- **Discounts (F6 / Shift+F6):** a popover takes `parseDiscountInput` and shows a live preview ("−58.16 → 523.44") and "Your limit is 5%". Over the cap, the approval dialog opens at once.

### 5.8 Sales, void, reprint (Alt+2)

- **List:** today's and this shift's sales: invoice, time, user, total, tenders, and a Voided / Returned badge. Search by invoice no., amount or product.
- **Detail:** lines, batches, payments, returns and audit rows, with [Reprint] [Void] [Return (M2b)].
- **Void:** shown only for current-shift sales with no returns. It asks for a reason and an approval, then says: "Give back Rs 965.00 cash. Reverse the Rs 1,000.00 card payment on the bank terminal."

### 5.9 Returns (M2b)

1. Scan the receipt barcode, or type `123` / `T1-000123`.
2. Per line: Sold / Returned / Return now (quick quantity), "Put back on shelf" (on by default; disabled for an expired batch), and a reason (1–6).
3. The refund method defaults to how the sale was paid, with card and wallet capped. The refund preview shows the rounding.
4. Approval when needed, then Enter. The drawer opens if cash goes out, and the return receipt is printed or previewed.

### 5.10 Shift (Alt+5)

- **Current shift:** who opened it and when, and the sale count. Expected cash appears only for users with `shift.view_expected`; the service doesn't send it to others.
- **Cash in/out (Alt+C):** In or Out, category 1–7, amount, note, Enter. The approval dialog appears above Rs 2,000.
- **Close:**
  1. Blind count with a denomination grid (5000 / 1000 / 500 / 100 / 50 / 20 / 10 / coins) or a single total.
  2. Submit. If a note is needed: "Cash is Rs 125.00 short — say why" (the count is locked).
  3. "Leave in drawer" defaults to the default float.
  4. Summary: expected vs counted, sales by method, returns, voids, cash in/out, warning counts, held sales and any clock warning.
  5. The Z report preview (printed in M2b), then "Backing up… ✓", then the lock screen.

### 5.11 Back office

- **Users** (owner): add (name, role, PIN), change role, reset PIN, unlock, deactivate.
- **Settings → Store:** rounding, default %, caps per role, Rx check, return days, near-expiry days, pay-out limit, variance note, default float, auto-lock, receipt footer and whether batches show.
- **Settings → This till's printer (M2b):**
  - Mode: **Off (show receipts on screen)** [default], Windows printer (the list starts with "Windows default printer") or Network (IP, port 9100).
  - Columns 48 / 42 / 32, cut, auto-print.
  - Cash drawer through the printer (pin 2 / 5), with [Print test page] (a preview when Off) and [Test drawer].
- **Settings → Backups:**
  - The last good backup, [Back up now], and a list (date, kind, size, ✓) with [Check].
  - Mirror folder (M2b): a typed path plus [Test folder].
  - [Restore…] arrives in M5. The browser preview says "Backups run in the desktop app".
- **Health** comes in M5 and the **audit log** viewer in M4.

---

## 6. Receipts and printing (fully usable with no printer)

### 6.1 Changes to `@app/receipt` (step 11)

- Add `indent?: number` on `text` and `pair` lines, because `wrap()` drops leading spaces.
- Add `{kind: 'barcode', data}`: CODE128 set B on paper, `*T1-000123*` in the preview.
- Add `{kind: 'feed', lines}`.
- Replace `openDrawer?: boolean` with `drawer?: {pin: 2 | 5}` and send the pulse **right after init**, so the drawer opens while the receipt prints.
- Add `drawerKick(pin)` (init + pulse) for a drawer open without a receipt.
- Add `PAPER_WIDTH.mm80small = 42`.
- Add `decodeEscPos(bytes): string[]`, which strips the commands, for tests and the fake printer.
- Templates: `saleReceipt`, `returnReceipt`, `voidSlip`, `shiftReport` and `testPage` (a 48-character ruler, bold, large text, a barcode and a cut). They depend on `@app/core` for `formatMoney`, with labels from `strings.ts`.
- Text stays ASCII (`toPrintable`). Urdu would need raster printing later.

### 6.2 Sample receipt (the worked sale, as the preview renders it; trailing spaces trimmed)

```
          S H I F A   P H A R M A C Y
      12 Main Bazar, Lahore - 0300-1234567
        Drug licence 01-352-0001-23456P
------------------------------------------------
Invoice T1-000123               21-10-2026 14:05
Cashier Annus                            Till T1
------------------------------------------------
1 Panadol 500mg Tablet
  2 Strips @ 245.00/Strip                 490.00
  Batch PN01 Exp Jun 2027
2 Brufen 400mg Tablet
  3 Tablets @ 24.57/Tablet                 73.70
3 Augmentin 625mg Tablet
  1 Strip, 2 Tablets @ 436.20/Strip       581.60
  Discount 10%                            -58.16
  Batch AU1123 Exp Mar 2027
4 Digital Thermometer
  1 Piece @ 899.99/Piece                  899.99
------------------------------------------------
Items total (4 items)                   2,045.29
Item discounts                            -58.16
Bill discount 2%                          -21.74
Rounding                                   -0.39
================================================
T O T A L   R s   1 , 9 6 5 . 0 0
Card (ref 4417)                         1,000.00
Cash received                           1,000.00
Change                                     35.00
Includes sales tax 18%: 137.29
You saved Rs 79.90
                  *T1-000123*
```

- **Large text:** the name and TOTAL lines are double size on paper. The preview letter-spaces them (`renderText`), and the printer doubles the width itself.
- **Separators:** `·` prints as `-`.
- **Rates and amounts:** the rate is display-only (24.57 per tablet); the amount (73.70) is rounded once.
- **Tax:** the tax line appears only for rates above 0%.
- **Banners:** reprints show `*** REPRINT ***` and voids `*** VOID ***`.

### 6.3 Bytes (80 mm, 576 dots, Font A, 48 columns)

| Command                                     | Bytes                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| Init                                        | `1B 40`                                                                                 |
| Code page PC437                             | `1B 74 00`                                                                              |
| Bold on / off                               | `1B 45 01` / `1B 45 00`                                                                 |
| Normal / double size                        | `1D 21 00` / `1D 21 11`                                                                 |
| Drawer pin 2 / pin 5 (50 ms on, 500 ms off) | `1B 70 00 19 FA` / `1B 70 01 19 FA`                                                     |
| Barcode                                     | `1D 68 50`, `1D 77 02`, `1D 48 00`, `1B 61 01`, `1D 6B 49 <n> 7B 42 <data>`, `1B 61 00` |
| Feed 4 + partial cut                        | `1B 64 04 1D 56 42 00`                                                                  |

### 6.4 Modes and flow (`apps/till/src/platform/printer.ts`, M2b)

**Modes:**

- **Off** (default): no Rust call; the preview is the result.
- **Windows:** `print_raw({mode: 'windows', printerName})`, a RAW spooler job (`printerName: null` means the Windows default).
- **Network:** `print_raw({mode: 'network', host, port})` over TCP 9100.

**Flow:**

1. The document's transaction commits. When printing is on with auto-print, it wrote `last_receipt = {docType, docId, status: 'pending'}` **in that same transaction**, so a power cut right after the commit still leaves the notice.
2. After the change panel is shown, `renderEscPos(template, {columns, cut, drawer})` goes to `print_raw`, fire-and-forget.
3. `last_receipt` is set to done or failed. At boot, pending or failed gives "Receipt for T1-000123 may not have printed — [Print] [Skip]".

**The drawer:**

- It kicks whenever cash moves (cash received, cash refunded, pay in/out, no-sale), the drawer is enabled and the mode isn't Off.
- If a receipt prints now, the pulse is inside it, right after init. Otherwise, for example with auto-print off, `drawerKick(pin)` is sent on its own.
- With printing Off or the drawer disabled, the screen says "Open the drawer by hand".
- A failed print never undoes or blocks a sale; the screen offers [Retry] and [Show on screen].

**Testing with no hardware:**

- Vitest golden texts and hex, and `decodeEscPos(renderEscPos(doc))` must equal `renderText(doc)`.
- `scripts/fake-printer.mjs` listens on 127.0.0.1:9100. It prints a readable dump (`[bold]`, `[drawer pin 2]`, `--- cut ---`) and saves `job-N.bin`. Point the desktop app at it in Network mode.
- "Generic / Text Only" on a file port captures a Windows spooler job.
- Playwright types barcodes with a 5 ms delay.

**Hardware acceptance checklist** (when the printer and scanner arrive):

1. The test-page ruler fits on one line (otherwise choose 42 columns).
2. Bold, large text and the cut work.
3. The drawer opens on pin 2 (else try pin 5), both with a receipt and with auto-print off.
4. The scanner sends an Enter suffix, with no prefix, on a US layout.
5. 30 scans a minute drop nothing.
6. Scanning while the Qty field has focus adds an item.
7. Scanning the receipt barcode in Returns finds the sale.
8. Unplug the printer and sell: the sale saves, and Retry works.
9. Pull the power plug 10 times, mid-cart and mid-Pay: every sale is either complete or still a cart, and `checkRecords` is clean.

---

## 7. Backups and restore

- **Where:** `%APPDATA%\com.pharmacypos.till\backups\`, plus an optional mirror folder in M2b (USB stick or D: drive). The mirror applies the same retention rule.
- **When:**
  - before migrations (`premigrate`; logged after migrating);
  - at login when the last good backup is over 24 h old (`auto`);
  - every 30 min, if `isBackupDue` and the till has been idle for 60 s with an empty cart (`auto`);
  - after shift close (`shift`);
  - on [Back up now] (`manual`).
- **How (built):**
  1. Rust opens a second, read-only connection and runs `VACUUM INTO '<dir>/<name>.partial'`.
  2. It syncs the file and runs `PRAGMA integrity_check`.
  3. It reads the check data (migrations, sale count, last sale, max outbox seq) and renames the file.
  4. Stale `.partial` files are removed at start-up.
- **Retention:** about 70 files at most. At 20–80 MB each during the pilot that is roughly 1.5–5 GB; the Backups screen shows the total.
- **Restore (M5, before the pilot):**
  1. Owner, PIN and typing RESTORE.
  2. `prepareRestore` refuses newer schemas.
  3. The Rust command keeps a safety copy named as a `prerestore` backup and swaps the file in.
  4. The app reloads, migrates, runs `afterRestore` (number floors) and takes a fresh backup.
  5. Restore is also reachable from the boot-failure screen.

  The Rust fixes in §8.2 land in M2a, because the command already exists.

- **Suggested for the pilot:** keep a USB stick plugged in, and every week swap it for a second stick that the owner takes home, until cloud backup arrives in M6.

---

## 8. Rust (`apps/till/src-tauri/src`; thin, no business rules)

Built in `7837bcd`: printing, printer list, backups, restore and the Windows CI job. The command names and shapes stay as they are (see "What I checked"), so nothing is renamed. Only the pieces below are new.

### 8.1 Dependencies

- **Printing:** nothing new; `windows-sys 0.61` with `Win32_Graphics_Printing` is in place. Don't add `windows` with printing features.
- **WebView2 change (M2b, step 24):** add `webview2-com = "=0.39.1"` and `windows-core = "=0.62.2"` under `[target.'cfg(windows)'.dependencies]`. Both are already in `Cargo.lock` as Tauri's own dependencies, so `--locked` builds download nothing. `cargo tree -d` must show no second copy.

### 8.2 `db.rs` and `backup.rs`

**M2a (step 18):**

- **Shared file lock:** one `static FILE_LOCK: Mutex<()>` is shared by `backup::create`, `copy_to`, `delete` and `Database::restore_from`. Restore uses `try_lock` and says "A backup is running — try again in a moment". This also stops a reader's late close from deleting the restored database's new `-wal` by name on Linux or macOS.
- **WAL files:** after closing the connection, `restore_from` deletes `-wal` and `-shm`. **If either still exists**, it reopens the old database, removes the staged file and returns "The till is busy — try again". Windows refuses to delete a file another handle has open, for example antivirus. Only then does it rename.
- **Tests:**
  - A read-only connection held on the live file during a restore → busy, and the old data is intact. This is meaningful on the existing `windows.yml` job; on Linux the delete succeeds, so the test checks only "old or new data, never mixed".
  - A `create` holding the lock makes `restore` return busy.

**M2b (step 25):** `dir` arguments (the mirror) are canonicalised and must be an existing directory: "The backup drive E:\ is not connected". Names stay as `check_name` allows. TypeScript always generates `till-YYYYMMDD-HHMMSS-<kind>.db`, and retention ignores names it can't parse, such as the tests' `till-1-auto.db`.

**M5:**

- `backup_restore` gains a third parameter, `marker: Value`, written as `restore-pending.json` (temporary file, then rename). The TypeScript caller changes then.
- `restore_marker_take()` returns the marker once.
- At start-up, a leftover `till.db.restoring` is completed if `till.db` is missing and deleted otherwise.

### 8.3 `printer.rs`

No change in M2. The File mode is dropped (D3).

### 8.4 `lib.rs` (M2b, step 24)

- On Windows, in `setup`, call `window.with_webview(|wv| …)`: `wv.controller().CoreWebView2()?.Settings()?`, cast it to `ICoreWebView2Settings3` (via `windows_core::Interface`) and call `SetAreBrowserAcceleratorKeysEnabled(false)`.
- After that, F5, Ctrl+R, Ctrl+P, F3, F7 and zoom do nothing, and key events still reach the page.
- Tauri 2.12 has no config option for this: wry has the setting, but tauri-runtime-wry doesn't call it.
- CI already compiles and lints the `cfg(windows)` code on `windows-latest` for PRs that touch `src-tauri/**`.

---

## 9. Tests

### 9.1 Core (Vitest)

**Built in `8ed4541`:**

- the worked example to the paisa;
- the cap need of 1180 and the 49.99 / 50.01 slack case;
- the MRP example;
- the property test over seeded carts;
- `extractTax`, `roundBill` (48750 → 48800; down 48799 → 48700);
- tenders, the allocation table, returns math, shift math;
- the permissions snapshot, pins, invoices, clock, backup rules, the cart and input parsing.

**New in step 1:**

- **allocation:** `needsConfirm` for the "50" row and for PN-01 5 + PN-00 20 selling 10; none when there is no shortfall;
- **tenders:** total 0 with no tenders → ok with no payments; total 0 with cash → `cash_not_needed`;
- **clock:** `behind` by 2 days is not blocking; implausible is; `effectiveToday` across Karachi midnight;
- **permissions:** the snapshot including approvable, `clock.reset` and `cost.view`;
- **cart:**
  - `normalizeCart` drops a Rs 100 discount after the quantity falls to 1 tablet (Rs 72.70) and drops a bill discount over the base;
  - `MAX_LINE_QTY`;
  - `confirmedInDate` is cleared by `setQty`, `bumpQty` and `cycleUnit`;
- **approvals:**
  - `grantScope` changes with qty, discount, bill discount, batches, pack batch and prescription, and is stable under key order;
  - `grantCovers` refuses another user and a need above `approved_bp` plus one paisa.

**Receipt package (step 11):** golden 48/42/32-column texts; the indent survives; REPRINT and VOID banners; golden hex; drawer bytes right after `1B 40`; `drawerKick`; the CODE128 length byte; `decodeEscPos(renderEscPos(d)) = renderText(d)`.

### 9.2 Services (`createTestApp`, in-memory SQLite, clock fixed at 21 Oct 2026, Karachi, `buildTime` 2026-10-01)

- **Migrations:** 0002 and 0003 on a database filled by M1 services keep the data. The 0002 guards (built) still fire. 0003's CHECKs and cascade work. **Upgrading an M1 database with a fake port** writes the `premigrate` `backup_log` row after migrating.
- **Auth:**
  - login; the wrong-PIN countdown; the 5th failure locks for 1 minute, and `setNow(+61 s)` unlocks;
  - the lockout survives a new context;
  - the recovery code resets and rotates;
  - the last owner can't be demoted;
  - self-approval → `FORBIDDEN`; an approver's wrong PIN counts against the approver.
- **Permissions:**
  - A cashier gets `FORBIDDEN` from `updateProduct` and `NEEDS_APPROVAL` from `voidSale`; with a pharmacist approval the void succeeds and records the approver.
  - An inventory clerk gets `FORBIDDEN` from `completeSale`.
- **Grants:**
  - A pharmacist approves 11.8% on L3. It is stored as `approved_bp 1180`, not 1500.
  - 15% on L1 still needs approval, and changing L3's quantity voids its grant.
  - Holding the draft deletes the grants.
  - After a lock, a different user completing the sale → `NEEDS_APPROVAL`.
  - A controlled grant stops covering when the prescription or the batch picks change.
  - `grantApproval` ignores any client-sent need.
- **Drafts:**
  - A draft saved to a temp-file database reopens with the same cart.
  - A save issued after `completeSale` changes 0 rows, and the next cart's `startDraft` and save work.
  - A save after `discardDraft` doesn't bring the cart back.
  - The hold limit; resume swaps; discard audits.
- **Shift:**
  - Only one open shift; expected cash 557500 recomputed; the two-phase close audits the count.
  - A pay-out above the drawer is blocked: **as a cashier the message has no amount**. Above the limit it needs approval.
  - `getShiftTotals` as a cashier → `expectedCash: null` until the count.
  - `getSellable` as a cashier has no `cost`.
- **`completeSale`:**
  - The worked sale is stored exactly: header, 4 lines, allocations, movements, payments, and one outbox row per synced insert.
  - Invoices `T1-000001` then `T1-000002`; with a floor of 50 → `T1-000050`.
  - **Atomicity:** `CREATE TEMP TRIGGER fail BEFORE INSERT ON payment …` makes the call throw, and every table's row count is unchanged, including `sync_outbox` and `audit_log`; the draft is still there.
  - **Idempotency:** a second call returns `alreadyCompleted` and writes nothing.
  - `TOTAL_CHANGED` after a price change.
  - **Unrecorded stock:** the placeholder is created once and reused, and real batches never go negative from FEFO.
  - **Expired on record:** both the all-expired and the some-in-date cases → `NEEDS_CONFIRMATION`, then they work once confirmed and are audited.
  - A manual expired batch fails on `lines.0.batches.0.batchId`.
  - A fixed discount above the line amount fails on `lines.0.discount`. A quantity of 8961234567890 fails on `lines.0.qty`, and nothing throws a `PricingError` or `RangeError`.
  - **Above MRP:** the flag and the audit; the `mrp` price.
  - **A total of 0:** no payments; `checkRecords` is clean.
  - **Controlled:** a missing prescription → field errors; a cashier without a grant → `NEEDS_APPROVAL`; with both → a `sale_prescription` row with the approver as dispenser; a typed pack batch creates a real batch and never touches the placeholder.
  - **Rx:** `not_seen` is audited, and `require_seen` blocks it. Khata → `NOT_AVAILABLE`. An override price → `NOT_AVAILABLE`.
  - **Clock:**
    - 2 days behind → the sale completes, `business_date` is the PC's date, expiry uses the high water, and `clock.suspect` is written once per shift;
    - implausible → `CLOCK_WRONG`;
    - a forward jump then a correction → a pharmacist resets the high water, and a batch expiring in the gap sells again.
- **Void and returns:**
  - A void reverses stock and payments exactly, so the sale's payments sum to 0. It is refused after the shift closes, a second time, or after a return.
  - Returns of 10 then 10 refund 24000 and 172500, and the total matches the sale.
  - Not restocked → no movement; an expired batch is forced not to restock.
  - Card refunds are capped at what was paid by card; a late return needs the owner's approval.
- **Backup** (fake port): due / not due; ok and failed log rows; a bad integrity result → failed; an `outboxSeq` lower than before → failed; a mirror failure doesn't fail the backup; pruning, and skipping it when the clock isn't ok.
- **Integrity:** a scripted day (open shift, 30 sales including one with a total of 0, 2 voids, 3 returns, a pay-out, close) leaves `checkRecords` empty and the rebuilt stock cache unchanged. **This and `full-day.spec` are the M2 "done when".**

### 9.3 Rust (`cargo test`, Linux and Windows CI)

- **Built:** names are checked; a backup holds only committed rows while a sale is in progress; copy, list and delete; restore with a safety copy; refused inside a transaction; `.partial` clean-up.
- **New:** the `FILE_LOCK` test and the WAL-files test from §8.2.
- **M5:** the marker and `.restoring` completion.

### 9.4 Playwright (browser preview, 1366×768, printing off)

**Helpers (step 4):**

- `setUpTill` fills the owner PIN twice, ticks the recovery code and logs in, then navigates to Products.
- A new `loginAs(page, name, pin)` helper.
- `catalog.spec` and `import.spec` must stay green in the same commit.

| Spec                                           | Covers                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login.spec`                                   | Setup with owner PIN and recovery code; lock/unlock; wrong PIN; lockout; the owner adds a cashier; Ctrl+L switches user                                                                                                                                                                      |
| `sale.spec` (keyboard only)                    | Open shift; scan `8961234567890` typed at 5 ms delay; `2s*panadol`; `3t*brufen`; F6 `10` → approval → pharmacist PIN; Shift+F6 `2`; F9 card + cash; change 35.00. The preview contains `T1-000001`, `Items total`, `Rounding` and `TOTAL`, with every line ≤ 48 characters; stock goes down. |
| `crash.spec`                                   | Add 2 lines → `page.reload()` → log in → lines restored; F5 doesn't lose the cart                                                                                                                                                                                                            |
| `warnings.spec`                                | Past-zero chip; above MRP → Alt+M; the expired-on-record dialog in both forms; unknown barcode; **a barcode typed slowly into the Qty field adds the item**; a scan burst in the cash field is ignored                                                                                       |
| `pay.spec`                                     | Total 0 ("Nothing to pay"); **typing "Nadia Younas" in Patient and a Raast reference doesn't change the Rx answer**; Alt+Y / Alt+N do                                                                                                                                                        |
| `hold.spec`, `void.spec`, `returns.spec` (M2b) | Each feature end to end                                                                                                                                                                                                                                                                      |
| `controlled.spec` (M2b)                        | Form + pharmacist PIN as a cashier; typing the batch from the pack                                                                                                                                                                                                                           |
| `shift.spec`                                   | Pay-out; blind close (a cashier sees no expected cash); a Rs 125 note; Z preview                                                                                                                                                                                                             |
| `printer.spec` (M2b)                           | Off by default; the test page shows the preview; Backups says "desktop app"                                                                                                                                                                                                                  |
| `full-day.spec`                                | 30 mixed sales; the Z totals equal sums computed in the test                                                                                                                                                                                                                                 |

---

## 10. Build order

Each step is one commit on a short branch off `main`. Run `pnpm check` and the cargo checks before each, with no AI attribution. Track the hours actually spent, and re-plan after step 7.

| #   | Step                                                                                                                                              | Est. h | Status           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- |
| 0   | Repo: push `m2-groundwork`, PR it into `main` with a merge commit, default branch → `main`, move the uncommitted work to a branch off `main` (D1) | 1      | To do            |
| —   | Receipt package base, PIN hashing                                                                                                                 | —      | Done (`b9f54e4`) |
| —   | Rust printing, backups, restore; Windows CI                                                                                                       | —      | Done (`7837bcd`) |
| —   | Core checkout rules                                                                                                                               | —      | Done (`8ed4541`) |
| —   | Migration 0002, `schema.ts`, M1 column writes                                                                                                     | —      | Done (`8290351`) |

**M2a — a full day of sales (≈ 128 h)**

| #   | Step                                                                                                                                                                                                                                                   | Est. h | Status                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Review fixes: `needsConfirm` + `confirmedInDate`; `packBatch`, `MAX_LINE_QTY`, `normalizeCart`; clock without "behind blocks"; `clock.reset`, `cost.view`, the approvable list; `approvals.ts`; migration 0003 + `schema.ts`; zero-total tests         | 5      | To do                                                                                                                                                                          |
| 2   | Auth and users, guards, `grantApproval` with scopes, permission checks in M1 services, `createTestApp` login; tests                                                                                                                                    | 10     | In progress (working tree). It must adopt step 1: scoped grants with a service-side need, no `clock.override` or `clockBlocks` for "behind", and no high-water raise at login. |
| 3   | Settings service (store + device)                                                                                                                                                                                                                      | 3      | In progress                                                                                                                                                                    |
| 4   | Till shell: boot with the `beforeMigrate` hook, setup PIN and recovery, owner PIN for M1 databases, login, lock and idle lock, approval dialog, gated nav, key guard, Sale as the default route; e2e helpers; `login.spec`; catalog/import specs green | 12     | In progress                                                                                                                                                                    |
| 5   | Users screen                                                                                                                                                                                                                                           | 3      | In progress                                                                                                                                                                    |
| 6   | Shift service (two-phase close, cash movements, blind totals, report data)                                                                                                                                                                             | 6      | To do                                                                                                                                                                          |
| 7   | Shift UI; `shift.spec`                                                                                                                                                                                                                                 | 7      | To do                                                                                                                                                                          |
| 8   | Drafts service (`startDraft`, UPDATE-only save); restart and race tests                                                                                                                                                                                | 3      | To do                                                                                                                                                                          |
| 9   | `buildSaleTx` and `planSale`                                                                                                                                                                                                                           | 8      | To do                                                                                                                                                                          |
| 10  | `completeSale` (atomicity, idempotency, `TOTAL_CHANGED`, grants, total 0, typed batch, `last_receipt`)                                                                                                                                                 | 8      | To do                                                                                                                                                                          |
| 11  | Receipt package: indent, barcode, feed, drawer after init, `drawerKick`, `decodeEscPos`, templates, golden tests                                                                                                                                       | 6      | To do                                                                                                                                                                          |
| 12  | Sale screen 1: scan box, dropdown and unit chips, quantity prefix, scan detector and barcode-in-field rule, draft start/save/flush/restore                                                                                                             | 8      | To do                                                                                                                                                                          |
| 13  | Sale screen 2: grid, line keys, totals panel, F1 help                                                                                                                                                                                                  | 6      | To do                                                                                                                                                                          |
| 14  | Pay (split tenders, suggestions, suspicious tender, total 0, Alt+Y/N), done panel and preview, last sale, reprint; `sale.spec`, `crash.spec`, `pay.spec`                                                                                               | 10     | To do                                                                                                                                                                          |
| 15  | Warnings (MRP chip and Alt+M, past zero, expired on record, near expiry), discount popovers with approval; `warnings.spec`                                                                                                                             | 7      | To do                                                                                                                                                                          |
| 16  | Hold and resume UI; `hold.spec`                                                                                                                                                                                                                        | 3      | To do                                                                                                                                                                          |
| 17  | Void service, sales list and detail; `void.spec`                                                                                                                                                                                                       | 6      | To do                                                                                                                                                                          |
| 18  | Backups: Rust `FILE_LOCK` and WAL-files check with tests; `BackupPort`, `runBackup`, scheduler, retention, pre-migration log, badge, Backups screen                                                                                                    | 8      | To do                                                                                                                                                                          |
| 19  | Clock: high water, banner, implausible block, date confirmation, reset; `effectiveToday` for expiry in checkout and stock views                                                                                                                        | 3      | To do                                                                                                                                                                          |
| 20  | `checkRecords`, the service-level full day and `full-day.spec`. **M2a is done.**                                                                                                                                                                       | 5      | To do                                                                                                                                                                          |

**M2b — before M3 (≈ 47 h)**

| #   | Step                                                                                                                                                                                                                                                                                                                                                                               | Est. h |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 21  | Returns service and screen, return receipt; `returns.spec`                                                                                                                                                                                                                                                                                                                         | 12     |
| 22  | Batch picker, the Rx setting, controlled capture (prescription, dispenser, typed batch from the pack); `controlled.spec`                                                                                                                                                                                                                                                           | 10     |
| 23  | Printing: adapter over `print_raw`, `last_receipt` notice, printer settings, test page, drawer and no-sale, `scripts/fake-printer.mjs`; `printer.spec`                                                                                                                                                                                                                             | 8      |
| 24  | WebView2 accelerator keys off (checked by hand on Windows 10 and 11)                                                                                                                                                                                                                                                                                                               | 3      |
| 25  | Mirror folder, `dir` hardening, mirror badge                                                                                                                                                                                                                                                                                                                                       | 2      |
| 26  | Docs: ADRs 0005 checkout records and signed payments; 0006 drafts and idempotent completion; 0007 PIN login, permissions and scoped approvals; 0008 printing and the drawer; 0009 backups, restore and number floors; 0010 clock guard; 0011 khata in M4 (the `khata_payment` table and expected cash). Updates to `plan.md`, `architecture.md`, `compliance-pk.md` and CLAUDE.md. | 4      |
| 27  | Buffer for the review and the hardware checklist                                                                                                                                                                                                                                                                                                                                   | 8      |

**Moved out of M2:**

- **M4:** the audit viewer (~3 h).
- **M5:** restore end to end (~8 h) and the Health screen (~3 h).
- **Later:** price override.

---

## 11. Risks

1. **Scope.** About 175 h (likely 140–210 h), or about 16 weeks at 11 h/week, against 4 planned, so the pilot moves by about 3 months unless the owner cuts scope (Q16). The cut line is M2a / M2b. If M2a slips, move hold/resume and the Users screen polish to M2b, and keep login, shift, sale, pay, preview, void and local backups.
2. **`planSale` latency** over IPC on a slow PC. It is debounced at 150 ms, and totals are computed locally with no wait. Budget under 50 ms for 20 lines with IN-list queries, and measure on a low-end PC.
3. **Draft saves.** Each one is an fsync on an HDD (10–30 ms). They are debounced and flushed before every state change. A failed save shows a red "Not saved" banner.
4. **WebView2 keys** must really be disabled on Windows. The browser preview can't block F6, F11 or Ctrl+D in Chrome, so every action also has a button. The draft survives a stray reload.
5. **PIN strength.** Anyone who copies `till.db` can brute-force the PINs offline. Mitigations: the lockout at the till, a 6-digit owner PIN, and a decision on file and backup encryption in M6.
6. **Warning fatigue at go-live.** Stock, MRP and expiry data will be wrong at first. The expired-on-record dialog will appear until expired batches are adjusted to 0 (M1 adjustments) or written off (M3). The chips are quiet, and the shift report counts them.
7. **Clock.** A dead CMOS battery (an implausible date) stops selling until someone with the Windows administrator password fixes the clock; a standard Windows account can't. Ask who holds it (Q17), and turn on "Set time automatically". After a forward jump, batches expiring in the gap stay blocked until a pharmacist or the owner resets the guard.
8. **Printers.** Cheap 80 mm printers vary:
   - some v4/XPS drivers refuse RAW (fall back to "Generic / Text Only" on the same port, or to network mode);
   - a spooler "success" only means queued, so Retry can print twice;
   - there is no paper-out status;
   - pin 2 vs 5 and 48 vs 42 columns are unverified until hardware arrives.
9. **Scanners.** A Tab suffix, an odd keyboard layout or a prefix breaks "scan = typing + Enter". The burst thresholds (6 characters, 35 ms) are guesses until a real scanner is timed.
10. **Backups on the same disk** don't survive a dead disk or a stolen PC, and USB sticks get pulled out. Real off-site copies come in M6.
11. **Restore not in M2.** Until M5, a damaged database during testing means copying a backup by hand from the folder the boot screen shows. No pilot data exists before M5.
12. **Database growth.** `sync_outbox` keeps a full JSON copy of every row, which roughly doubles the database and every backup. M6 prunes sent rows.
13. **Legal unknowns:** medicine tax rates, the rounding rule, the mandatory controlled-drug fields and how long to keep them, and return rules. All are settings or free text, but the defaults may change before the pilot.
14. **M6 multi-till.** The placeholder batch is unique per product and will need merging across tills, and so will batches typed from packs. Held drafts and grants are local. The triggers were kept replay-safe on purpose.
15. **Profit on unrecorded stock** uses the product's usual cost, so it is approximate until the M3 counts settle those batches.
16. **Browser-preview e2e** runs on localStorage SQLite (no WAL or fsync). It proves the recovery logic, not power-cut durability; that needs the manual plug-pull test on the desktop build.

## 12. Questions for the owner

1. **"Main should be default":** I read this as making `main` the GitHub default branch, with all work merging there, plus the Sale screen as the home screen after login. Is that right? If you meant naming the till or branch "Main", invoices would read `MAIN-000123`.
2. **Above MRP:** should the check use what the customer actually pays after discounts (proposed), or the printed rate before discounts?
3. **Discounts:** what is the store default %? Are caps of 5% for cashiers, 15% for pharmacists and 100% for the owner right? Which items are never discounted (formula milk, devices)?
4. **Rounding:** nearest Re 1 (proposed), or always down in the customer's favour? Should card and wallet bills be rounded too?
5. **Returns:**
   - Is 7 days the right window?
   - Should cashiers need approval for returns and voids (proposed)?
   - Are opened strips and fridge items returnable?
   - Can a card sale be refunded in cash?
   - Are controlled drugs ever taken back?
6. **Rx-required (not controlled) items:** record "seen / not seen" (proposed), or require a prescription?
7. **Controlled drugs:**
   - Are patient name, prescriber, PMDC no. and Rx date enough, or do you also need CNIC or an address?
   - Must a pharmacist be logged in, or is a pharmacist's PIN on a cashier's sale acceptable?
   - Is typing the batch and expiry from the pack acceptable when the stock isn't recorded?
   - Is "one prescription per sale" fine?
   - How long must records be kept?
8. **Shifts:** one drawer per till with staff switching inside a shift (proposed), or a drawer per cashier? Should cashiers count blind? Are Rs 100 for a variance note, a Rs 5,000 float and a Rs 2,000 pay-out limit right?
9. **Wallets:** which JazzCash / Easypaisa / Raast merchant accounts does the store have, and what reference should staff type?
10. **Khata:** is deferring it to M4 acceptable? (The pilot starts after M5, so it will exist by then.)
11. **Receipts:** print batch and expiry (proposed yes)? What footer and return-policy wording? Is Urdu needed? Print every receipt, or ask first to save paper? (The drawer opens either way.)
12. **Hardware:** which printer and scanner will the pilot use? USB or Ethernet? Which drawer pin? Is the paper 80 mm?
13. **Backups:** where should the second copy go (USB stick or second drive), and who takes a copy home each week?
14. **Invoice numbers:** continuous forever (`T1-000123`), or reset each year? Is a visible gap after an emergency restore acceptable?
15. **Auto-lock:** is 5 idle minutes right?
16. **M2 length:** do you accept about 175 h (about 16 weeks at 10–12 h/week) instead of 4 weeks, which moves the pilot by about 3 months? Or which of the items in §10 should move later?
17. **Clock:** who at the store has the Windows administrator password to fix the date? May the PC set its time automatically when online?
18. **Cost prices:** should cashiers be unable to see cost prices (proposed: owner, pharmacist and inventory clerk only)?

---

## Review notes

| #   | Critique item                                                                                              | Verdict                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Design written against an old commit; Rust APIs differ                                                     | **Accepted, updated**              | HEAD has moved again, to `8290351`: core (`8ed4541`) and migration 0002 (`8290351`) are committed too. `origin/main` is 5 commits behind, not 3. The design now keeps the built command names and shapes (`print_raw`, `backup_restore(name, safetyName)`, `BackupCheck.integrityOk/saleCount`, the loose `check_name`, the synchronous `app_info`), drops the duplicate `windows` dependency and CI item, specifies only the missing Rust pieces, and puts all five commits in one PR. The PR is opened from a neutrally named branch so no tool name lands in the merge commit. |
| 2   | Approvals unscoped (limit = approver's cap, any line, never expire)                                        | **Accepted**                       | 0003 rebuilds `draft_approval` with `kind`, `line_key`, `scope_json`, `approved_bp` (the need, not the cap) and `requested_by`. `grantCovers` requires an exact scope and the same seller. Holding the sale deletes grants, and login clears other users' grants. The need is computed in the service from the saved draft; the working tree's client-sent `needBp` goes.                                                                                                                                                                                                         |
| 3   | Expired-stock confirmation only when all stock is expired                                                  | **Accepted**                       | `needsConfirm = shortfall > 0 && expiredQty > 0`, verified on the critique's example and on the existing "50" row. Two message forms; audited `sale.expired_on_record`.                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4   | Late upsert re-inserts a completed draft                                                                   | **Accepted, different fix**        | The proposed `INSERT … WHERE NOT EXISTS (sale) … ON CONFLICT` still resurrects a _discarded_ draft and still needs the row for the approval FK. Instead the draft row is created when the cart starts, saves are `UPDATE`-only and never write status (verified: 0 rows on a deleted draft), every state change flushes first, and `completeSale` reads the cart from the draft row.                                                                                                                                                                                              |
| 5   | Estimate too low; M2a beyond plan scope                                                                    | **Accepted**                       | Re-estimated per step: about 175 h. The clock is now a warning, price override is deferred, the File mode dropped, the audit viewer moved to M4, and Health and restore to M5. Owner sign-off is Q16.                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | Clock block stops cashier shifts; a forward jump poisons business dates                                    | **Accepted, one part not adopted** | Only "implausible" blocks. "Behind" is a banner plus `clock.suspect`. Business dates use the PC's date, and `effectiveToday` applies to expiry only. A pharmacist or the owner resets the guard, and §4.8 says who fixes each case. Making the "ahead" confirmation trigger a reset is **not** adopted: confirming a far-ahead date is when the high water should rise; a reset belongs after the jump is corrected.                                                                                                                                                              |
| 7   | `__BUILD_TIME__` and PIN iterations in packages and tests                                                  | **Accepted**                       | `buildTime` and `pinIterations` are on `ServiceContext` (already in the working tree), `createTestApp` passes 2026-10-01 and 1,000, and `vitest.config.ts` defines the global for app tests.                                                                                                                                                                                                                                                                                                                                                                                      |
| 8   | Blind count leaks through messages; cost hidden only in the UI                                             | **Accepted**                       | The pay-out and cash-refund messages have no amount without `shift.view_expected`. `getShiftTotals` returns `expectedCash: null` until the count. A new `cost.view` permission filters `getSellable`, `getProduct` and `getProductStock`. Tested as a cashier.                                                                                                                                                                                                                                                                                                                    |
| 9   | A zero-total sale can't be completed                                                                       | **Partly rejected**                | The code already handles it: `settleTenders(0, [])` returns ok with **no** payment rows (verified). The cash row is built only when cash due > 0, so `CHECK (amount <> 0)` is never hit, and `checkRecords`' empty sum is 0. The missing UI ("Nothing to pay"), documentation and tests are added.                                                                                                                                                                                                                                                                                |
| 10  | Pre-migration backup writes `backup_log` before 0002 creates it                                            | **Accepted**                       | The hook keeps the `BackupCheck` in memory, and the log row is written after migration; tested with a fake port on an M1 database.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | Restore swaps next to an undeletable WAL; backup and restore can overlap                                   | **Accepted**                       | Shared `FILE_LOCK`, and abort-and-reopen when `-wal`/`-shm` survive the delete. The overlap is worse than stated: on Linux a backup reader closing late could delete the restored file's new WAL by name. The test is meaningful on the existing Windows CI job.                                                                                                                                                                                                                                                                                                                  |
| 12  | `last_receipt` written after the commit; no drawer kick with auto-print off                                | **Accepted**                       | `last_receipt` is written inside the document's transaction when printing is on. A cash document always kicks the drawer when it is enabled, either inside the receipt or with `drawerKick`.                                                                                                                                                                                                                                                                                                                                                                                      |
| 13  | Core errors shown as bugs; fixed discount breaks after a quantity change; barcode typed into Qty overflows | **Accepted**                       | Note: at HEAD, pricing throws a typed `PricingError`, not a `RangeError`, but it is still not an `AppError`. Services now validate before pricing and map leftovers. `normalizeCart` drops discounts that no longer fit, and `MAX_LINE_QTY = 99,999`. A 6–14-digit value in Qty or discount fields is a scan at any speed. The overflow was verified (`divRound needs safe integers`).                                                                                                                                                                                            |
| 14  | FORBIDDEN vs NEEDS_APPROVAL undefined; `sale.discount` and `clock.reset` permissions missing               | **Accepted, one part rejected**    | There is an approvable column (matching the working tree's `APPROVABLE_PERMISSIONS`), discounts use the typed kind `'sale.discount'`, and `clock.reset` replaces `clock.override`, with a snapshot test. **Rejected:** making `clock.reset` owner-only. After a forward jump, the person on duty must be able to fix it, so pharmacists hold it, a cashier can get their PIN, and it is audited.                                                                                                                                                                                  |
| 15  | Controlled drug with no recorded batch is unclear; one prescription per sale unstated                      | **Accepted**                       | The batch no. and expiry are typed from the pack, creating a real batch (never the placeholder). One prescription per sale is stated in D15 and §5.6, and asked in Q7.                                                                                                                                                                                                                                                                                                                                                                                                            |
| 16  | Khata collections fit neither cash table                                                                   | **Accepted**                       | D5 and ADR 0011: M4 adds a `khata_payment` table and extends expected cash, `getShiftTotals` and `checkRecords`. No schema change now.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 17  | Plain Y/N in the Pay dialog clash with text fields                                                         | **Accepted**                       | Alt+Y / Alt+N, or plain Y/N only while the Rx choice has focus; covered by `pay.spec`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 18  | e2e `setUpTill` breaks after the login step                                                                | **Accepted**                       | Step 4 updates `setUpTill`, adds `loginAs`, and keeps `catalog.spec` and `import.spec` green in the same commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 19  | Contradictory examples                                                                                     | **Accepted**                       | The MRP chip is removed from the discounted line in the mock and explained below it. "Rs 6.50 short" is now "Rs 125.00 short". L2 is written "3t". The label "Subtotal 2,045.29" is now "Items total" on the screen and receipt. The undefined "X report" is dropped.                                                                                                                                                                                                                                                                                                             |
