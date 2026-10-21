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
