# Order counters and cash counters — design

> **Status:** proposal, not built. Based on `cecc62e`.
>
> **Why:** many pharmacies don't sell from one till. Salesmen at several counters take the order, and the customer pays at a cash counter. Some shops have one till that does everything, and big shops have several cash counters. Today the app runs one till per store, and `plan.md` says a second till needs cloud sync (M6).
>
> **Open questions:** the defaults below need the store's answers (§13). Each one names its question, e.g. **(Q4)**.

## Words used here

| Word                    | Meaning                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| **Main PC**             | The PC that holds the store's database. Usually cash counter 1.                                          |
| **Till** (cash counter) | A PC that takes money: it has a drawer, a shift and its own invoice series (T1, T2 …). It can also sell. |
| **Order counter**       | A PC that builds orders and never takes money (C1, C2 …).                                                |
| **Order**               | A cart sent from a counter (or a till) to be paid at any till. It has a short number for the day.        |
| **Joined PC**           | Any PC in the store other than the main PC.                                                              |

---

## 1. The three shop setups

| Setup                                   | PCs                                                                        | What changes for the shop                                                         |
| --------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **A. One till**                         | One PC: the main PC, a till                                                | Nothing. No network, no new screens, no new steps.                                |
| **B. Counters + one cash counter**      | Main PC = till T1; counters C1 … Cn                                        | Counters send orders; T1 shows waiting orders and takes payment.                  |
| **C. Counters + several cash counters** | Main PC = T1; tills T2 …; counters C1 … (or several tills and no counters) | Any till opens any waiting order; each till has its own drawer, shift and series. |

All three run the same app. A shop moves from A to B or C by joining more PCs to the main PC; nothing is reinstalled and no data moves.

```
            ┌──────────── shop network (cable + switch, on the UPS) ────────────┐
Counter C1 ─┤                                                                    ├─ Till T2 (joined)
Counter C2 ─┤                                                                    │  drawer, shift, T2-…
            └──────────────────────────────┬─────────────────────────────────────┘
                                           │
                                 Till T1 = main PC
                          till.db (the store's only database),
                         backups, drawer, shift, T1-… invoices
```

---

## 2. Decisions

| #   | Topic                     | Decision                                                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                                        |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | One database per store    | The store's database lives on the main PC. Other PCs join it over the shop's own network. There are no copies to keep in step and no sync between PCs. No internet is needed.                                                                                                                                                            | One stock count, one catalog, nothing to merge. Sync is the hardest part of M6. Local pharmacy software already works this way, so shops have the cabling. |
| N2  | Two kinds of PC           | `device.kind` is `till` or `counter`. **A till** has a drawer, a shift and an invoice series; it sells, opens orders and can also send its cart to the queue (setup C). **A counter** builds, holds and sends orders; it can't open a shift, take payment, move cash or void. The owner can change a PC's kind.                          | The PC decides what is physically possible (a drawer or not). Roles keep deciding who may do what.                                                         |
| N3  | Main PC                   | The PC set up first. In setup A it is the only till; in B and C it is usually cash counter 1. It must be on while the shop is open **(Q3)**.                                                                                                                                                                                             | Payments stop without the cash counter anyway, so tying the database to it adds little risk.                                                               |
| N4  | Orders are drafts         | An order is a `sale_draft` row with the new status `sent`. Sending keeps the cart, its approvals, the Rx answer and any prescription. Opening it at a till makes it that till's active draft, like resuming a held sale. Completing it is today's `completeSale`, and `sale.id = draft.id` still holds.                                  | Reuses drafts, D8's crash safety and its safe retry of a completion.                                                                                       |
| N5  | Stock and money at a till | Counters never write stock movements, payments or invoices. Nothing is reserved while an order waits. The till rechecks prices, batches and stock at payment; `TOTAL_CHANGED` and the sale warnings already do this.                                                                                                                     | One place settles each sale. "Sales never stop" means there is nothing to reserve.                                                                         |
| N6  | One till per order        | Opening an order is one conditional update (`WHERE status = 'sent'`), so two tills can't open it together. The second sees "Order 47 is open at Till T2". A till can put an order back in the queue.                                                                                                                                     | Setup C, at rush hour.                                                                                                                                     |
| N7  | Order numbers             | Per store and per day: Order 1, 2, 3 … shown in large type, said aloud, and printed on an optional slip with a CODE128 barcode `ORD` + `yymmdd` + number (`ORD261026047`).                                                                                                                                                               | Short enough to call out. The barcode is unique across days and can't clash with a product barcode.                                                        |
| N8  | Who took the order        | `sale.taken_by` (who sent the order) and `sale.order_no` are recorded. `sale.user_id` stays the cashier who took the money. A walk-in sale at a till has neither.                                                                                                                                                                        | Sales per salesman (M4 report) and accountability **(Q6)**.                                                                                                |
| N9  | Approvals travel          | A grant made at a counter (discount over the cap, controlled drugs) covers the order for whoever completes it, while its scope still matches. D10's scope rules are unchanged: a changed line needs a new PIN. A pharmacist who sends an order with controlled lines is recorded as the dispenser.                                       | The pharmacist approves at the counter, where the customer, the prescription and the medicine are.                                                         |
| N10 | Same services on every PC | Joined PCs run the same TypeScript services. Their SQL goes to the main PC over the network: the Rust side forwards `db_execute`. Each joined PC gets its own connection on the main PC. A transaction is rolled back after 5 s without a statement. **Measured:** completing the 4-line worked sale is 59 statements; planning it is 8. | No second copy of business rules. ADR 0001 holds: Rust only carries statements.                                                                            |
| N11 | Pairing and encryption    | A PC joins with a one-time code shown in the main PC's Settings (owner only). Every request carries that PC's key, and the main PC stores only a hash of it. Traffic is TLS with a certificate the main PC makes for itself; the joining PC remembers it at pairing. The main PC answers only private-network addresses.                 | A joined PC can read everything, PIN hashes included (M2 risk 5). Shop Wi-Fi is often shared with customers **(Q13)**.                                     |
| N12 | One clock                 | Joined PCs use the main PC's time: the offset is measured at connect and every 10 minutes. The clock guard (D12) runs on that time. A joined PC whose own clock is more than 2 minutes off shows a notice.                                                                                                                               | Documents from several PCs must agree. Only one Windows clock has to be right.                                                                             |
| N13 | One version               | Only the main PC runs migrations. A joined PC whose app version differs from the main PC's refuses to start and says which PC to update. Update the main PC first.                                                                                                                                                                       | One schema, one set of rules.                                                                                                                              |
| N14 | One-till shops            | The network server stays off until the owner adds a PC. Order screens appear only when the store has more than one PC.                                                                                                                                                                                                                   | Setup A is the most common shop. It must not pay for B and C.                                                                                              |

**Rejected:**

- **A database on every PC, synced between them.** That is M6's sync, brought forward: conflicts, placeholder batches to merge, catalog edits on several PCs. Counters would gain little, because without the cash PC nobody can pay.
- **Paper or QR slips with no network.** Counters would still need the catalog, prices and stock, so the problem stays.
- **Running the services on the main PC (remote calls instead of SQL).** Fewer round trips, but the main PC's screen would become a server, and every service would need a second entry point. Kept as the fallback if N10 turns out too slow (risk 1).

---

## 3. How a day looks

### 3.1 Setup A

Unchanged.

### 3.2 At an order counter

1. The salesman logs in as today. The status bar says "Counter C1 · main PC T1 ✓".
2. They scan or search, set quantities, pick batches (F4) and add line discounts within their cap, exactly as on the Sale screen. Warnings (past zero, above MRP, near expiry) show as today.
3. **F9 Send** (in place of Pay) opens the Send dialog: the Pay dialog without tenders. It asks the Rx question, takes controlled-drug details with a pharmacist's PIN when needed, and accepts an optional customer name (the label).
4. The done panel shows **ORDER 47** in large type and "Pay at the cash counter". With a printer set up, the slip prints **(Q8)**. Any key starts the next order.
5. **Hold** works as today (the customer went to fetch a prescription).
6. Before a till opens it, the counter can **take an order back** to add an item **(Q14)**. The order list shows it as "Open at Counter C1".

### 3.3 At a till

1. The status bar shows **Orders 3**. **F7** opens the waiting orders: number, from (C2 · Bilal), age, first items, total, and chips for Rx, controlled and "approval needed".
2. Enter, or scanning the slip, opens the order. The current cart, if it has lines, is held first (as `resumeDraft` does). A strip above the lines says "Order 47 · from C2 (Bilal) · 3 min ago".
3. The cashier can remove items the customer doesn't want, or add some; removals are logged as today (`cart.removed`) **(Q4)**. Discounts: the cashier's cap applies, unless a counter approval still covers the line **(Q5)**.
4. **F9 Pay** as today. The Pay dialog shows the Rx answer and prescription from the counter. The receipt adds "Order 47 · Bilal" **(Q12)**.
5. **F8** on an order puts it back in the queue instead of holding it, so another till can take it.
6. A walk-in customer is served at the till as today.

### 3.4 Several tills (setup C)

- **Drawers:** each till has its own shift and drawer, and its own invoice series (`T2-000123`). This is already the case.
- **Orders:** any till can open any waiting order (N6).
- **Sending from a till:** a till can send its cart to the queue (F9 → "Send instead"), so the customer can pay at a shorter line.
- **Returns:** a return can be taken at any till. The refund comes from that till's drawer, under the existing cash, card and wallet limits **(Q11)**. The Sales screen searches every till: `T2-000123` finds T2's sale, and a bare number searches this till.
- **Voids** stay at the till that made the sale, inside its shift. The trigger rule from D13 is unchanged.

### 3.5 Orders that are never paid

- They stay in the queue. From the next day they carry a "Yesterday" chip.
- A pharmacist or the owner cancels them with a reason. A cashier needs their PIN. The cancel is audited (`order.cancel`) with the lines and total **(Q10)**.
- Shift close and the shift report show "4 orders waiting in the store". This is a warning, not a block. An order that is never paid while the medicine left the shop is the main theft risk in this way of working, so the till keeps it visible.

### 3.6 When the network or the main PC is down

- **A joined PC loses the main PC.** It shows a red banner, "Can't reach the main PC (Till T1) — retrying", and stops. The cart on screen is kept and saved when the link is back.
- **The main PC goes down.** Every joined PC stops. The shop falls back to paper until the main PC is back. Its data is as safe as today: WAL and `synchronous = FULL`.
- **The main PC dies.** Restore its latest backup on another PC and make that PC the main PC (§8). This needs the M5 restore screen; until then it is done by hand.

---

## 4. Schema: migration `0003-store-network`

**Synced tables** (ADD COLUMN only):

```sql
ALTER TABLE device ADD COLUMN kind TEXT NOT NULL DEFAULT 'till' CHECK (kind IN ('till', 'counter'));
ALTER TABLE device ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));

ALTER TABLE sale ADD COLUMN order_no INTEGER CHECK (order_no > 0);
ALTER TABLE sale ADD COLUMN taken_by TEXT REFERENCES app_user (id)
  CHECK ((taken_by IS NULL) = (order_no IS NULL));
CREATE INDEX sale_taken_by_idx ON sale (taken_by, business_date) WHERE taken_by IS NOT NULL;
```

`sale` is append-only. Adding columns doesn't touch its triggers, and old rows read as walk-in sales.

**Local tables, rebuilt** (SQLite's table-rebuild steps, inside the migration; held sales and their approvals must survive, see §9):

- **`sale_draft`:**
  - `status` allows `'sent'`.
  - New columns: `order_no`, `order_date`, `sent_by` (user), `sent_from` (device) and `sent_at`. They are all set or all NULL, and `status = 'sent'` requires them.
  - `device_id` now means "the PC that has it open, or held it".
  - New indexes: a unique `(order_date, order_no) WHERE order_no IS NOT NULL`, and `(status, sent_at) WHERE status = 'sent'` for the queue.
  - Unchanged: one `active` row per device.
- **`draft_approval`:** the check becomes `approver_id <> requested_by OR kind = 'sale.controlled'`, so a pharmacist sending their own controlled order can be recorded as the dispenser (N9). Only `sendOrder` writes such a row; `verifyApprover` still refuses your own PIN.

**New local table:**

```sql
CREATE TABLE device_key (
  device_id TEXT PRIMARY KEY,   -- no foreign key: the key is issued before the device row exists
  key_hash TEXT NOT NULL,       -- SHA-256 of the joined PC's key
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
```

**`local_meta`:**

| Key                                                                            | Change                                                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `device_settings`, `last_receipt`, `invoice_floor`, `return_floor`             | Become per PC: `device_settings:<deviceId>` and so on. The migration renames the main PC's existing keys. |
| `network`                                                                      | New. JSON `{enabled, port}`.                                                                              |
| `pairing`                                                                      | New. JSON `{codeHash, expiresAt}`: the current one-time code. Rust reads it; TypeScript writes it.        |
| `order_counter`                                                                | New. JSON `{date, last}`. Order numbers are never reused within a day, even after a cancel.               |
| `branch_id`, `device_id`, `owner_user_id`, `recovery_hash`, `clock_high_water` | Unchanged and store-wide. `device_id` is the main PC's own id; joined PCs keep theirs in `store.json`.    |

`SYNCED_TABLES` is unchanged. `device` and `sale` are already synced, and `device_key` is local. Update `schema.ts` and add the migration to `migrations/index.ts`.

---

## 5. Rust (`apps/till/src-tauri/src`)

### 5.1 Main PC: `server.rs` (new)

- **When it runs:** TypeScript calls `network_start` at boot when `network.enabled` is set, before anyone logs in. It listens on one fixed port.
- **Discovery:** it answers a UDP broadcast on the same port with the store name and its address, so staff don't type IP addresses.
- **Endpoints** (JSON over HTTPS):

  | Endpoint | Does                                                                                                                                                                       |
  | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `/pair`  | Checks the one-time code (hash, expiry, single use; 5 wrong tries end it). Returns a new device id, the branch id and a random key; stores the key's hash in `device_key`. |
  | `/hello` | Checks the key and the app version. Returns the main PC's time and version.                                                                                                |
  | `/sql`   | Runs one statement on this PC's connection (same result shape as `db_execute`).                                                                                            |
  | `/reset` | Rolls back this PC's open transaction.                                                                                                                                     |

- **Connections:** one SQLite connection per joined PC, opened with the same pragmas (WAL, `synchronous = FULL`, foreign keys, 5 s busy timeout). The main PC's own app keeps its IPC connection.
- **Lease:** a transaction with no statement for 5 s, or open for more than 15 s, is rolled back, and the next request on that connection gets `TX_ABORTED`. A joined PC that loses Wi-Fi mid-sale can't hold the write lock.
- **Refusals:** an unknown or revoked key; an address outside 10/8, 172.16/12, 192.168/16 and link-local; a request over 1 MB.
- **TLS:** a self-signed certificate (rcgen) made at first start and kept in the data folder; rustls.
- **Dependencies:** a small HTTP server, rustls, rcgen, sha2. They are chosen and pinned to exact versions in step 1. Prefer the ones already in Tauri's tree.

This is transport only. `server.rs` has no business rules, and it writes only `device_key` (a local table).

### 5.2 Joined PC: `remote.rs` (new)

- **`store.json`** in the data folder: main PC address and port, certificate fingerprint, device id, branch id and key. A joined PC has no `till.db` of its own.
- **Forwarding:** `db_execute` and `db_reset` go to the main PC; `app_info` gains `mode: 'main' | 'joined'` and the ids.
- **New commands:** `network_discover` and `network_pair`.
- **Errors:** network failures come back as `NETWORK: …` text, which the app shows as the red banner. Reconnecting is automatic.
- **HTTP client:** rustls, with only the remembered certificate accepted.

### 5.3 Installer

The installer adds a Windows Firewall inbound rule for the port on private networks. Without it, Windows asks for an administrator the first time the main PC listens.

---

## 6. Services (`packages/db/src/services`)

### 6.1 Opening a joined PC

- `openDatabase` doesn't migrate. It reads the main PC's last migration and compares versions (N13).
- `loadDevice` reads the ids from `store.json` (through the platform) instead of `local_meta`.
- `ctx.now` is the PC's clock plus the measured offset (N12).

### 6.2 `orders.ts` (new)

- **`sendOrder(ctx, {draftId, label?})`** needs `order.send`. One transaction:
  1. The draft is this PC's active one, with lines.
  2. **Validation:** `buildSale` validation errors (archived product, expired batch picked, a missing controlled batch) refuse the send on their fields, as Pay does. Missing approvals don't refuse it; they show at the till.
  3. **Controlled lines** need the prescription and either a sender with `sale.controlled` (who then gets the self-recorded grant, N9) or a pharmacist's grant.
  4. **Number:** the next `order_counter` number for `today`.
  5. **Update:** `status = 'sent'`, plus `order_no`, `order_date`, `sent_by`, `sent_from` and `sent_at`. Grants are kept.

  It returns `{orderNo, slip}`. The screen then calls `startDraft`.

- **`listOrders(ctx)`** returns sent orders, plus orders open on other PCs ("Open at Till T2"). Each has its number, the sender's PC and name, age, line count, total, first items and flags.
- **`openOrder(ctx, {draftId} | {code})`** opens an order by id or by slip barcode. One transaction:
  1. Hold the current active draft, or drop it if it is empty (as `resumeDraft`).
  2. `UPDATE … SET status = 'active', device_id = :me WHERE id = ? AND status = 'sent'`.
  3. If no row changed: `INVALID_STATE` "Order 47 is open at Till T2" (or "was paid" or "was cancelled").

  A counter may open only orders it sent; a till may open any.

- **`putBackOrder(ctx, {draftId})`** sets the active order back to `sent` and keeps its grants.
- **`cancelOrder(ctx, {draftId, reason, approval?})`** needs `order.cancel`, which cashiers can get with a PIN. It audits `order.cancel` `{orderNo, lines, total, sentBy, reason}` and deletes the draft (its grants cascade).

### 6.3 Changes to existing services

- **`completeSale`:**
  - **Orders:** when the draft has an `order_no`, the sale gets `order_no` and `taken_by = sent_by`.
  - **Counters:** on a counter it refuses with `FORBIDDEN` "This PC is an order counter. Payments are taken at a cash counter." The same refusal goes in `openShift`, `recordCashMovement`, `recordNoSale`, `voidSale` and returns, through one `requireTillTx` guard.
- **`grantCovers`** (`core/approvals.ts`): for an order, a grant also covers when `requestedBy` is the order's `sent_by`. The scope must still match exactly.
- **`holdDraft`** on an order puts it back (`putBackOrder`) instead.
- **`closeShift`:** an open order on this till gives "Put the order back or finish it". `getShiftTotals` adds `waitingOrders` for the store.
- **`listSales`, `findSale` and `getLastSale`:** `findSale` uses the till code in the text to pick the till; `listSales` takes a till filter (default: this till).
- **Returns:** a sale from another till can be returned here. The refund limits use this till's drawer.
- **`nextDocSeqTx`:** floors are read per PC.
- **New `devices.ts`:**
  - `enableNetwork` creates the first pairing code.
  - `newPairingCode` makes a 6-digit code, valid for 10 minutes.
  - `joinStore` runs on the joining PC once it is paired. It `insertRow`s its `device` row and audits `device.join`.
  - `listDevices` gives code, name, kind, last seen and version.
  - `updateDevice` changes the name or kind.
  - `removeDevice` sets `is_active = 0`, revokes the key and audits it.
- **Permissions** (`core/permissions.ts`):
  - `order.send`: owner, pharmacist and cashier.
  - `order.cancel`: owner and pharmacist; a cashier can do it with a PIN.
  - `devices.manage`: owner.
  - **No new role (Q7).** A cashier at a counter PC can only send orders, because the PC has no Pay.

---

## 7. UI (`apps/till`)

- **Setup screen:** two choices, "Set up a new store" (today) and "Join a store on this network". Joining:
  1. Pick the main PC from the ones found, or type its address.
  2. Type the code shown on the main PC.
  3. Name this PC and choose Till or Counter. Codes are suggested: T2, C1.
  4. The usual login screen follows, because users are shared.
- **Settings → PCs in this store** (owner):
  - "Let other PCs join" shows this PC's address and turns the server on.
  - "Add a PC" shows a code for 10 minutes.
  - The list shows each PC with [Rename] [Till/Counter] [Remove].
- **Counter mode:**
  - The Sale screen's F9 is "Send to cash counter", with the Send dialog and done panel (§3.2).
  - Shift (Alt+5), cash in/out, the no-sale drawer, void and returns are hidden.
  - Backups are hidden on every joined PC; they run on the main PC.
- **Till:**
  - The "Orders n" badge and F7 list, the order strip, and F8 on an order meaning put back.
  - A scanned `ORD…` code in the scan box opens that order.
- **Status bar on joined PCs:** "Counter C1 · main PC T1 ✓", and the red banner when the link is lost (§3.6).
- **Freshness:**
  - Today every query is cached until this PC acts (`staleTime: Infinity`). With more than one PC in the store, the order list refetches every 2 s, and other screens refetch when opened.
  - Stock on a counter can be a few seconds old. The till rechecks everything at payment.
- **Text:** all new text goes in `strings.ts`.

## 8. Receipts and slips (`packages/receipt`)

- **Order slip.** It reuses the double-size text and CODE128 support already there:
  - store name;
  - **ORDER 47** in double size;
  - counter, salesman and time;
  - each item with quantity and amount, then the total;
  - "Pay at the cash counter";
  - the barcode.

  It gets a golden test like the receipt's.

- **Sale receipt:** one more line, "Order 47 · Bilal", when the sale came from an order.

## 9. Failures and recovery

- **The link drops mid-transaction.** The lease rolls it back (§5.1). Retrying is safe: `completeSale` with the same draft id returns `alreadyCompleted` when the first attempt did commit. This is already built (D8).
- **A COMMIT's reply is lost.** Same as above: the retry finds the sale.
- **A joined PC loses power.** Typing since the last draft save is lost: at most 150 ms when the link was up, as today.
- **The main PC loses power.** Same as today for the data. The main PC and the network switch need the UPS **(Q2)**.
- **Upgrading `sale_draft`.** The migration rebuilds the table. A test upgrades a database with held sales and grants and checks they all survive.
- **Making another PC the main PC** (M5, with the restore screen):
  1. Restore the latest backup on that PC.
  2. "Make this the main PC" turns `store.json` into a local database and starts the server.
  3. The other PCs find it again by discovery and keep their keys, which are in the restored `device_key`.
- **Backups:** they stay on the main PC (D14). The mirror folder can be a shared folder on another PC.

## 10. Tests

| Layer               | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core (Vitest)       | `grantCovers` for orders: covered for the cashier while the scope matches, not after a change. Order barcode parsing.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Services (Vitest)   | A new helper, `joinTestPc(t, 'counter' \| 'till')`, gives a second `AppContext` (another device) on the same in-memory database. Cases: send and pay; two tills opening one order; put back; cancel and its audit; a counter refused payment, shift and void; approvals carried; self-recorded dispensing; `taken_by` and `order_no` on the sale; order numbers across midnight and after a cancel; a return at another till; `findSale` across tills; per-PC floors. Plus `checkRecords` over a full day with two tills and two counters. |
| Migration           | Upgrade a database with held sales and grants from 0002; everything survives.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Rust (`cargo test`) | Connections are separate per PC; the lease rolls back; key, revoked key and address checks; the pairing code is single use, expires and locks after 5 tries; the version check; forwarding on the joined side.                                                                                                                                                                                                                                                                                                                             |
| End to end          | A small dev "main PC", `scripts/dev-main.mjs`, speaks the same protocol over plain HTTP on localhost with node:sqlite. The browser preview uses it when started with `?main=…`. Playwright then runs a counter page and a till page together, and two tills racing for one order.                                                                                                                                                                                                                                                          |
| By hand             | Two real PCs, on cable and on Wi-Fi: time `completeSale`, pull the cable mid-sale, switch off the main PC.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 11. Build order and estimate

Hours are at the same rough level as `m2-design.md` §10.

| #   | Step                                                                                                                                             | Hours                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 1   | **Spike:** forward `db_execute` to a second PC over plain HTTP and time the worked sale on cable and Wi-Fi on a low-end PC. Go or no-go for N10. | 6                                                             |
| 2   | Migration 0003, `schema.ts`, per-PC meta keys, the `requireTillTx` guard                                                                         | 6                                                             |
| 3   | Rust server and client: connections, leases, keys, TLS, discovery; the firewall rule                                                             | 20                                                            |
| 4   | Joining: setup choice, pairing, PCs screen, `store.json`, version check, main PC clock                                                           | 14                                                            |
| 5   | `orders.ts`: send, numbers, list, open, put back, cancel; approvals; `taken_by`                                                                  | 16                                                            |
| 6   | Screens: counter mode, Send dialog, waiting orders, order strip, freshness, status bar                                                           | 14                                                            |
| 7   | Several tills: search across tills, returns at any till, waiting orders at shift close                                                           | 5                                                             |
| 8   | Order slip and the receipt line                                                                                                                  | 4                                                             |
| 9   | Dev main PC and end-to-end tests, Rust tests, the migration test                                                                                 | 12                                                            |
| 10  | ADR 0012 ("One store database on the main PC"; M2 uses 0005–0011), `architecture.md`, `plan.md`, user guide                                      | 4                                                             |
|     | **Total**                                                                                                                                        | **≈ 100 h** (likely 80–130), about 9–10 weeks at 10–12 h/week |

- **Setup B** needs steps 1–6, 8 and 9. **Setup C** adds step 7.
- **Timing:** if the pilot store is B or C **(Q1)**, this goes before M5 (the pilot). If it is A, it can follow the pilot, before M6.
- **`plan.md`:** "a second till needs sync (M6)" becomes "other PCs join the main PC over the shop network".

## 12. Effect on other plans and risks

**Other plans:**

- **M6** syncs one database per store, from the main PC only. M2 risk 14 (merging placeholder and typed batches across tills) goes away inside a store; it remains only across branches.
- **M5:** auto-update must update the main PC first, or accept a short stop of joined PCs. Restore gains "Make this the main PC" (§9).
- **D11:** invoice and return floors become per PC (§4).

**Risks:**

1. **Speed on Wi-Fi.** 59 round trips at 5–15 ms is 0.3–0.9 s with the write lock held. If the spike shows more than about 1 s, cash tills need cable, or `completeSale` moves to the main PC as a remote call (the rejected option kept as fallback).
2. **The main PC is a single point of failure.** It needs the UPS, power settings that keep it awake (no sleep or hibernate), and a practised restore.
3. **Windows.** The firewall prompt (§5.3); the main PC's address changing (discovery handles it; a DHCP reservation on the router helps); antivirus blocking the port.
4. **Version skew** during updates (N13).
5. **Security.** Any paired PC can read the whole database. Removing a PC revokes its key, so a stolen counter PC must be removed at once.
6. **Write lock.** A slow joined PC can hold other tills' writes for up to the 5 s lease.
7. **Stale counters.** Stock on a counter can be a few seconds old; the till's recheck covers it.
8. **Unpaid orders** where the medicine left anyway. The till can only make them visible (§3.5).
9. **Rebuilding two local tables** on upgrade (§9).

---

## 13. Questions for the store

| #   | Question                                                                                                              | Default in this design                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Q1  | Which setup does the pilot store have: one till, counters + one cash counter, or several cash counters? How many PCs? | All three are designed. The answer decides whether this comes before the pilot.                   |
| Q2  | Are the PCs connected by cable or only Wi-Fi? Are the router and switch on the UPS?                                   | Cable for tills, Wi-Fi is fine for counters; the switch on the UPS.                               |
| Q3  | Which PC is on whenever the shop is open?                                                                             | Cash counter 1 is the main PC.                                                                    |
| Q4  | Can the cashier change an order, or does the customer go back to the counter?                                         | The cashier can add and remove items; removals are logged with who removed them.                  |
| Q5  | Who gives discounts: the salesman, the cashier, or both?                                                              | Both. At payment the cashier's cap applies, unless a counter approval still covers the line.      |
| Q6  | Do you track sales per salesman (targets, commission)?                                                                | `taken_by` is recorded now; the report comes with M4.                                             |
| Q7  | Do salesmen ever take money? Do you want a "Salesman" role that can never take payment?                               | No new role. Counter PCs have no Pay. (A new role needs a rebuild of `app_user`, a synced table.) |
| Q8  | Does each counter have a printer for slips, or do customers just say the number?                                      | The number on screen; a slip prints if the counter has a printer.                                 |
| Q9  | Who hands over the medicine, and when? Is the bag kept at the counter until the customer shows the receipt?           | The till doesn't track hand-over.                                                                 |
| Q10 | What happens to orders never paid by closing time?                                                                    | They stay until a pharmacist or the owner cancels them; shift close shows them.                   |
| Q11 | Can a customer return items at any cash counter?                                                                      | Yes, refunded from that counter's drawer.                                                         |
| Q12 | Should the receipt name the salesman?                                                                                 | Yes, "Order 47 · Bilal".                                                                          |
| Q13 | Is the shop Wi-Fi shared with customers?                                                                              | Assumed yes: pairing and encryption in any case.                                                  |
| Q14 | Can a salesman take an order back after sending it (the customer adds an item)?                                       | Yes, while no till has it open.                                                                   |
