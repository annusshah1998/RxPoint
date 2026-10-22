# RxPoint (working name)

An offline-first point of sale and inventory system for independent pharmacies and small
chains, starting in Punjab, Pakistan. Checkout with loose-tablet sales, stock by batch and
expiry, purchasing from distributors, customer credit (khata) and reports.

The name is a placeholder and will change before launch. It lives only in
`packages/config/product.json`.

**Status:** milestone 1 of 7 is done: catalog, search, opening stock, expiry views and
CSV import. Milestone 2 (checkout) is in progress: login and roles, shifts, the Sale
screen, payments, hold/resume, void, receipt preview and backups work; returns and real
printing are next. No printer or scanner is needed to try it. See
[docs/plan.md](docs/plan.md).

## Try it

Prerequisites: Node 22.13+, pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm dev            # browser preview at http://localhost:1420 (data stays in that browser)
```

End-to-end tests need a Chromium for Playwright: run
`pnpm --filter @app/till exec playwright install chromium` once, or point `CHROMIUM_PATH`
at an installed Chromium.

To run the desktop app you also need Rust (https://rustup.rs) and, on Windows, the
Microsoft C++ Build Tools and WebView2 (already on Windows 10/11). See
https://v2.tauri.app/start/prerequisites/.

```sh
pnpm tauri dev      # desktop app; the database file lives in the app data folder
pnpm tauri build    # Windows installer in apps/till/src-tauri/target/release/bundle/nsis
```

## Commands

| Command                                 | What it does                                                            |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm check`                            | Everything CI checks: product name, formatting, lint, types, unit tests |
| `pnpm test`                             | Unit tests (Vitest)                                                     |
| `pnpm test:e2e`                         | End-to-end tests in the browser preview (Playwright)                    |
| `cargo test` (in `apps/till/src-tauri`) | Rust tests                                                              |
| `pnpm format`                           | Format all files                                                        |
| `pnpm sync:name`                        | Copy the product name into the Tauri config after renaming              |

## Layout

```
apps/till/            Desktop till: React UI (src/), Tauri shell (src-tauri/), e2e tests
packages/config/      Product name and market defaults
packages/core/        Business rules with no database access
packages/db/          SQLite schema, migrations and services
docs/                 Plan, architecture, compliance notes, decision records
```

More in [docs/architecture.md](docs/architecture.md).
