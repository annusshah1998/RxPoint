# 0002: Money in paisa, stock in base units, prices per pack

**Status:** accepted (M1)

## Decision

- Money is a whole number of paisa everywhere (database, services, UI state after
  parsing). Never floats. STRICT tables reject fractions.
- Quantities are whole base units (tablet, capsule, bottle). Pack sizes are conversions.
- Prices and costs are stored as printed: an amount for a pack (`sale_price` for
  `price_qty` base units; batch `cost_price`/`mrp` for `pack_qty`).
- A line total is computed once: `round(amount × qty ÷ perQty)`, halves away from zero.
  Selling 3 tablets from a Rs 245.67 strip of 10 is Rs 73.70, not 3 × Rs 24.57.

## Why

Loose sales (one tablet from a strip) are the norm. Storing a per-tablet price would
round on every pack and drift; storing the pack price keeps the printed number exact and
rounds only where money changes hands. Distributor bonus schemes ("10+1") also fit:
the batch cost is the paid amount spread over all units received.
