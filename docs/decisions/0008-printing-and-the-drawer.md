# 0008: Printing and the cash drawer

**Status:** accepted (M2); not yet tried on a real printer

## Context

The pilot will use a cheap 80 mm ESC/POS thermal printer with the cash drawer plugged into
it, but none is available for testing, and many stores have no printer at all. Printing
must never decide whether a sale happened: a jammed printer can't lose or block a sale.
Inside WebView2, F5, Ctrl+R and Ctrl+P act before the page can cancel them, so a stray key
could reload or print the page mid-sale.

## Decision

- **TypeScript builds the bytes, Rust only delivers them.** One receipt document
  (`@app/receipt`) renders both the 48-column on-screen preview and the ESC/POS bytes, and
  golden tests check that decoding the bytes gives the preview text. Rust's `print_raw`
  sends a job to a Windows printer as a RAW spooler job, or over TCP port 9100 (3 s to
  connect, 5 s to write, at most 256 KB). Text is ASCII only.
- **Three modes per till, Off by default:** Off (receipts shown on screen), Windows printer
  (or the Windows default) and Network. No File mode: `scripts/fake-printer.mjs` covers
  that path. Settings → This till's printer also sets columns (48 / 42 / 32), cut,
  auto-print and the drawer pin (2 or 5), with [Print test page] and [Test drawer].
- **Print after the commit.** When printing is on with auto-print, the document's own
  transaction writes `local_meta.last_receipt = {docType, docId, status: 'pending'}`. After
  the commit the job runs (one at a time, `features/printing/print-jobs.ts`) and the status
  becomes done, failed or skipped. At the next start a pending or failed receipt shows
  "Receipt for T1-000123 may not have printed — [Print] [Skip]". A failure offers [Retry]
  and [Show on screen], and stays in a "Printer problems" bar once the cashier moves on.
- **The drawer opens only through the printer.** For a cash sale, cash refund or void the
  pulse goes right after the printer's init, so the drawer opens while the receipt prints.
  With auto-print off, and for cash in/out and Open drawer (Alt+D), the pulse is sent on its
  own after the record is saved. [Test drawer] is audited (`drawer.test`). The boot notice's
  [Print] never opens the drawer. With printing Off or no drawer, the screen says "Open the
  drawer by hand for the cash."
- **Testing with no hardware:** the fake printer saves each job and a readable dump. In
  development the Vite dev server forwards Network jobs (`apps/till/dev-printer-bridge.ts`,
  never in a build), so the browser preview and `e2e/printer.spec.ts` print to it.
- **Browser keys off in the desktop app.** `src-tauri/src/webview.rs` sets WebView2's
  `AreBrowserAcceleratorKeysEnabled` to false at start-up (through `webview2-com` 0.39.1 and
  `windows-core` 0.62.2, the copies Tauri already uses). Key events still reach the page,
  so the till's own shortcuts work, and the page's key guard (`app/keys.ts`) stays. A
  failure is logged ("Browser keys left on: …") and the till still starts. The setting also
  turns off F12, so debug builds open the developer tools on F12 and Ctrl+Shift+I through an
  `AcceleratorKeyPressed` handler; release builds have none.

## Alternatives considered

- **HTML printing through the WebView (`window.print`):** a dialog per receipt, slow,
  driver-dependent margins and no drawer pulse.
- **OPOS / vendor drivers:** per-model installs that a part-time developer can't test.
- **Printing inside the sale's transaction:** a slow or dead printer would hold the write
  lock or fail the sale.
- **A File mode in Rust:** dropped; the fake printer tests the same bytes with no Rust
  change.
- **Keys:** cancelling them in the page alone doesn't work in WebView2; waiting for a Tauri
  option (wry has the setting, but tauri-runtime-wry 2.12 never calls it) leaves the till
  exposed.

## Consequences

- Every feature works and is tested with no printer; printing is a setting, not a
  requirement.
- Unverified until hardware arrives (`docs/m2-design.md` §6.4): 48 or 42 columns, pin 2 or
  5, the cut, Windows v4/XPS drivers that refuse RAW jobs, and a spooler "success" that only
  means queued, so Retry can print (and pulse) twice.
- WebView2's right-click menu (Back, Refresh, Print) is not affected by the key setting.
  The keys still need checking by hand on Windows 10 and 11 (§6.4, item 10).
- **Differences from the design:** no Rust change was needed. With printing on, the done
  panel shows the print status instead of the preview ([Show on screen] shows it and marks
  the receipt skipped). A void prints the sale marked `*** VOID ***`. The shift's Z report
  is shown but not printed yet.
