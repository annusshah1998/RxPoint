# 0009: Backups, restore and number floors

**Status:** accepted (M2); restore screen and floors are used from M5

## Context

The till's data lives in one SQLite file on one PC, and cloud backup only comes in M6.
Disks die, PCs are stolen and power cuts are common. A backup must never pause a sale, must
be checked before it is trusted, and must leave the store a copy somewhere other than the
till's own disk. After a restore, invoice numbers already handed to customers must never
be issued again.

## Decision

- **How:** Rust runs `VACUUM INTO '<name>.partial'` from a second, read-only connection
  (in WAL mode that is a consistent snapshot of committed data, and the till keeps
  selling), syncs the file, runs `PRAGMA integrity_check`, reads the migrations, sale count,
  last sale and highest outbox seq, then renames it. A copy is good only if the check passes
  and its outbox seq is not lower than the database's just before it started.
- **Windows: open with write access before syncing.** `sync_all` is `FlushFileBuffers`,
  which Windows refuses on a read-only handle ("Access is denied (os error 5)"). Every file
  the Rust side syncs (backup, mirror copy, folder probe, restore staging) is opened with
  write access.
- **When:** while someone is logged in, the till checks every 10 minutes and backs up when
  there is no good copy, the last is a day old, or it is 2 hours old and records changed
  (`isBackupDue`); after a shift closes; and on [Back up now]. Names come from the clock
  (`till-20261021-140500-auto.db`), so nothing runs while the date is implausible
  (ADR 0010).
- **Retention:** thinned by a fixed rule from the newest file, never from "now": all
  within 48 h, the newest per day for 30 days, per month for 12 months, the 3 newest
  pre-migration and pre-restore copies. Names it can't parse are never deleted.
- **Backup drive (mirror):** Settings → Backups takes a second folder per till (a USB stick
  or another drive), given as a full path. Every good backup is copied there (`.partial`,
  sync, rename) and thinned by the same rule. A missing drive never fails the backup or
  blocks a sale: `backup_log` records `mirror_status = 'failed'` and `mirror_error` ("The
  backup drive E:\ is not connected"; migration `0003-backup-mirror`). Amber badges show
  "Backup overdue" after 26 h and "Backup drive not updated" after 3 days without a copy.
  The Backups screen can [Check] any backup still on disk.
- **Restore:** the Rust command `backup_restore` exists: it refuses inside a transaction,
  checks the backup, writes a safety copy as a `prerestore` backup, stages the file beside
  the live one, closes, removes `-wal`/`-shm` and renames. The restore screen comes in M5.
- **Number floors:** `nextDocSeqTx` numbers invoices and returns as
  `max(highest + 1, floor)`, with `invoice_floor` and `return_floor` in `local_meta`. From M5
  a restore sets each floor to the old database's highest number + 1 when it is readable,
  otherwise the restored highest + 1000. `checkRecords` accepts gaps only at a floor.

## Alternatives considered

- **Copying the file:** unsafe while the WAL holds recent commits.
- **The SQLite online backup API on the main connection:** blocks writes while it copies;
  a sale would wait.
- **A counter in `local_meta` for invoice numbers:** drifts from the records and goes back
  after a restore.
- **Cloud backup now:** needs the M6 server; the USB stick covers a dead disk until then.
- **Restore in M2:** not needed for a full day of sales, and no pilot data exists before M5.

## Consequences

- A backup never blocks a sale, and every copy is checked before it counts. About 70 files
  at most; at 20–80 MB each that is roughly 1.5–5 GB during the pilot.
- Backups run only in the desktop app; the browser preview says so.
- A stick that is pulled out or full only warns. Real off-site copies wait for M6; until
  then the owner should swap the stick weekly and take one home.
- Until M5, recovering from a damaged database means copying a backup by hand.
- **Lesson (`5ac4102`):** `File::open(path)?.sync_all()` works on Linux and passed CI
  there, but from `7837bcd` (21 Oct 2026) to `5ac4102` (27 Oct) every backup, copy, folder
  check and restore failed in the Windows app. The Windows CI job runs only on `main`, tags
  and pull requests touching `src-tauri`, so run `cargo test` on Windows before committing
  Rust changes.
- **Differences from the design:**
  - The pre-migration backup (`openDatabase(executor, {beforeMigrate})`) is not built:
    `open.ts` just migrates, so migration 0003 ran with no `premigrate` copy. It is needed
    before the first installer that carries a new migration.
  - The shared Rust `FILE_LOCK` between backup and restore, and the restore refusing when
    `-wal`/`-shm` survive the delete (§8.2, planned for M2a), are not built: restore still
    ignores a failed delete. Both are needed before the M5 restore screen.
  - The schedule checks every 10 minutes while logged in rather than waiting for 60 idle
    seconds with an empty cart; the copy uses its own connection, so selling isn't
    affected.
