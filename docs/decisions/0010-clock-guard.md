# 0010: The clock guard

**Status:** accepted (M2)

## Context

The till has no trusted time source: it works offline, and shop PCs often have a dead CMOS
battery (the date jumps to 2009), a mis-set date or a clock someone moved. Records carry
the PC's time, and expiry checks use today's date, so moving the clock back would make
expired stock sellable. On the other hand, blocking every sale whenever the clock looks a
little off would stop a cashier-only shift that can't fix Windows' time.

## Decision

- **High water:** `local_meta.clock_high_water` is the latest time any document was
  written. Every sale, void, return, cash movement and shift open or close raises it in the
  same transaction (`bumpClockTx`); it never goes down, and login doesn't raise it.
- **`assessClock`** (`packages/core/src/clock.ts`) gives one of four readings:
  - **Implausible** (before the build time − 1 day, from `ctx.buildTime`, or after 2035):
    services refuse shifts and documents with `CLOCK_WRONG`, and the till shows a full
    screen with how to fix the date in Windows. There is no override; the block lifts by
    itself once the date is right. Backups don't run, because their names come from the
    clock.
  - **Behind** the high water by more than 10 minutes: an amber banner; selling continues.
    `clock.suspect` is audited once per shift, and the shift report notes it.
  - **Ahead** by more than 3 days: the date is confirmed once at Open shift
    (`clock.date_confirmed`).
  - Otherwise **ok**.
- **Two dates.** Business dates (shift, sale, return) are the PC's own date in Karachi.
  Expiry checks alone use `effectiveToday = max(today, the high water's date)`, in checkout,
  returns (restock) and the stock views.
- **Reset:** after a forward jump is corrected, the high water stays in the future and
  expiry runs ahead. A pharmacist or the owner (a cashier with their PIN) presses [The clock
  is right — reset], allowed only while the clock reads behind. It sets the high water to
  now and is audited `clock.reset` with before and after.

## Alternatives considered

- **Block whenever the clock is behind** (the first design: more than 24 h): stops a
  cashier-only shift that can't change Windows' time, for a clock that may only be slightly
  off.
- **An owner "override" that lets the till sell with a wrong clock:** dropped; it writes
  records with a date known to be wrong.
- **Internet time:** the till is offline-first. Turning on Windows' "Set time
  automatically" is recommended, but the guard can't rely on it.
- **Trust the PC clock:** a dead battery writes records dated 2009, and moving the clock
  back unblocks expired stock.

## Consequences

- An implausible date stops selling until someone with the Windows administrator password
  fixes it; a standard Windows account can't (owner question Q17).
- After a forward jump, batches that expire in the gap stay blocked until the guard is
  reset.
- With the clock behind, documents can carry times earlier than the ones before them, so
  invoice order is `invoice_seq`, not time; `clock.suspect` marks the shifts affected.
- A PIN lockout more than 15 minutes in the future is ignored, so a clock moved back can't
  lock someone out for days.
- In M6, uploads should carry server time and a till whose clock is off should warn
  (ADR 0004).
- **Differences from the design:** none in the rules. The till checks the clock every
  minute (every few seconds while the date is wrong) and after every write
  (`features/clock/ClockGuard.tsx`).
