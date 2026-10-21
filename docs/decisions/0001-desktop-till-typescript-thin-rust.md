# 0001: Desktop till on Tauri, business logic in TypeScript

**Status:** accepted (M1)

## Context

The till must keep selling with no internet, print to thermal printers and open cash
drawers, and run on modest Windows PCs. It is built by one part-time developer who
doesn't know Rust.

## Decision

- Tauri 2 desktop app (small installer, low memory, WebView2 on Windows).
- All business logic in TypeScript packages (`core`, `db`) that run anywhere and are
  tested in Node.
- A thin Rust layer owns the SQLite file and will own the printer and cash drawer. It
  only runs single SQL statements and converts values.
- Kysely as a typed query builder over a tiny `SqlExecutor` interface, implemented for
  Tauri (Rust), the browser (SQLite WebAssembly) and Node tests (node:sqlite).

## Alternatives considered

- **Electron + better-sqlite3**: one language, mature, but a ~100 MB installer and higher
  memory use; auto-updates over slow connections suffer.
- **tauri-plugin-sql**: no transaction API, and a sale must save all-or-nothing.
- **Business logic in Rust**: fast and safe, but two languages and no reuse in the cloud
  API.
- **PWA only**: fastest to ship, but browser storage can be cleared and printing goes
  through dialogs.

## Consequences

- Rust changes are rare and small; CI runs `cargo fmt`, `clippy` and tests.
- The browser preview lets screens be built and tested without the desktop shell.
- Windows installers are built on GitHub Actions (`windows-latest`).
