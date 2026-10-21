import product from '../product.json';

/**
 * Product identity. `product.json` is the only place the product name is written;
 * everything else (UI, window title, receipts) reads it from here.
 * To rename: edit product.json, then run `pnpm sync:name`.
 */
export const PRODUCT = {
  name: product.name,
  description: product.description,
} as const;

/** Defaults for the first market (Pakistan). Per-store settings can override these later. */
export const MARKET = {
  country: 'PK',
  currency: 'PKR',
  /** Symbol printed before amounts on screen and receipts. */
  currencySymbol: 'Rs',
  /** Minor units per major unit (paisa per rupee). */
  minorPerMajor: 100,
  locale: 'en-PK',
  timeZone: 'Asia/Karachi',
} as const;

/** Inventory defaults. */
export const INVENTORY = {
  /** A batch counts as "near expiry" when it expires within this many days. */
  nearExpiryDays: 90,
} as const;

/**
 * Store-wide checkout settings used until the owner changes them (Settings → Store).
 * Money is paisa; rates are basis points (100 = 1%).
 */
export const CHECKOUT_DEFAULTS = {
  /** Bills round to the nearest rupee. */
  rounding: { step: 100, mode: 'nearest' },
  /** Discount applied to every discountable line unless changed. */
  defaultDiscountBp: 0,
  /** Highest discount each role may give without approval. */
  discountCapBp: { owner: 10_000, pharmacist: 1_500, cashier: 500, inventory: 0 },
  /** Unit added by a search hit: the smallest sellable pack above one item, or the base unit. */
  defaultSaleUnit: 'strip',
  /** Checkout warns when a batch expires within this many days. */
  saleNearExpiryDays: 30,
  /** Prescription-required items: record "seen / not seen", or require "seen". */
  rxCheck: 'record',
  /** Returns after this many days need the owner. */
  returnDays: 7,
  /** Pay-outs above this need a pharmacist or the owner. */
  payOutLimit: 200_000,
  /** A cash count this far off needs a note. */
  varianceNoteAt: 10_000,
  /** Suggested opening float. */
  defaultFloat: 500_000,
  autoLockMinutes: 5,
  maxHeld: 10,
  receipt: { showBatch: true, showSavings: true, footer: [] as string[] },
} as const;
