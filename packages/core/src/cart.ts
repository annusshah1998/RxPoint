import type { DiscountSpec, PricingLine } from './checkout';
import type { Money } from './money';
import type { PackPrice } from './pricing';
import { breakdownQty, findBaseUnit, sortUnitsLargestFirst, type UnitDef } from './units';
import { pluralize } from './text';

/**
 * The sale being rung up, as plain data. Every change goes through these functions and
 * returns a new cart; the screen saves it as a draft after each change, so a crash or
 * power cut loses nothing. Totals always come from `priceSale(toPricingLines(cart))`.
 */

export interface CartUnit extends UnitDef {
  id: string;
  isSellable: boolean;
}

export type RxKind = 'none' | 'required' | 'controlled';

export interface CartLine {
  key: string;
  productId: string;
  /** "Augmentin 625mg" */
  name: string;
  units: CartUnit[];
  /** The unit the quantity was entered in (for display and +/-). */
  unitId: string;
  /** Base units. */
  qty: number;
  /** The catalog price when the line was added. */
  listPrice: PackPrice;
  /** The price used: catalog, the batch MRP, or an approved override. */
  price: PackPrice;
  priceSource: 'catalog' | 'mrp' | 'override';
  priceReason: string | null;
  discount: DiscountSpec | 'default' | 'none';
  allowDiscount: boolean;
  taxRateBp: number;
  /** Batches picked by hand (the strip in hand); null = automatic (first to expire). */
  batches: { batchId: string; qty: number }[] | null;
  rx: RxKind;
  schedule: string | null;
  /** The cashier confirmed the pack in hand is in date though only expired stock is on record. */
  confirmedExpiredOnly: boolean;
}

export interface PrescriptionInput {
  patientName: string;
  patientPhone?: string | null;
  prescriberName: string;
  prescriberRegNo?: string | null;
  rxDate?: string | null;
  rxRef?: string | null;
}

export interface RemovedLine {
  productId: string;
  name: string;
  qty: number;
  gross: Money;
  at: string;
  by: string;
}

export interface Cart {
  version: 1;
  id: string;
  startedAt: string;
  userId: string;
  lines: CartLine[];
  selectedKey: string | null;
  billDiscount: DiscountSpec | null;
  rxCheck: 'seen' | 'not_seen' | null;
  prescription: PrescriptionInput | null;
  /** Lines removed before payment, kept for the audit log. */
  removed: RemovedLine[];
  /** The last removed line, for undo. */
  undo: { line: CartLine; index: number } | null;
}

export function newCart(id: string, userId: string, startedAt: string): Cart {
  return {
    version: 1,
    id,
    startedAt,
    userId,
    lines: [],
    selectedKey: null,
    billDiscount: null,
    rxCheck: null,
    prescription: null,
    removed: [],
    undo: null,
  };
}

/** What the screen knows about a product when adding it. */
export interface CartProduct {
  productId: string;
  name: string;
  units: CartUnit[];
  price: PackPrice;
  allowDiscount: boolean;
  taxRateBp: number;
  rx: RxKind;
  schedule: string | null;
}

function replaceLine(cart: Cart, key: string, update: (line: CartLine) => CartLine): Cart {
  return { ...cart, lines: cart.lines.map((l) => (l.key === key ? update(l) : l)) };
}

/** A plain line can absorb a repeat scan; one with a picked batch, price change or discount can't. */
function canMerge(line: CartLine): boolean {
  return line.batches === null && line.priceSource === 'catalog' && line.discount === 'default';
}

/**
 * Adds `qty` base units of a product. Scanning the same product again adds to its line
 * (when that line is still plain), keeping the unit it was entered in.
 */
export function addItem(
  cart: Cart,
  product: CartProduct,
  unitId: string,
  qty: number,
  key: string,
): Cart {
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new RangeError('qty must be positive');
  const existing = cart.lines.find((l) => l.productId === product.productId && canMerge(l));
  if (existing) {
    const merged = replaceLine(cart, existing.key, (l) => ({ ...l, qty: l.qty + qty }));
    return { ...merged, selectedKey: existing.key };
  }
  const line: CartLine = {
    key,
    productId: product.productId,
    name: product.name,
    units: product.units,
    unitId,
    qty,
    listPrice: product.price,
    price: product.price,
    priceSource: 'catalog',
    priceReason: null,
    discount: 'default',
    allowDiscount: product.allowDiscount,
    taxRateBp: product.taxRateBp,
    batches: null,
    rx: product.rx,
    schedule: product.schedule,
    confirmedExpiredOnly: false,
  };
  return { ...cart, lines: [...cart.lines, line], selectedKey: key, undo: null };
}

/** Sets a line's quantity (base units). A manual batch pick no longer matches, so it is cleared. */
export function setQty(cart: Cart, key: string, qty: number, unitId?: string): Cart {
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new RangeError('qty must be positive');
  return replaceLine(cart, key, (l) => ({
    ...l,
    qty,
    unitId: unitId ?? l.unitId,
    batches: l.batches && sumQty(l.batches) === qty ? l.batches : null,
  }));
}

function sumQty(parts: readonly { qty: number }[]): number {
  return parts.reduce((s, p) => s + p.qty, 0);
}

function unitOf(line: CartLine): CartUnit {
  return line.units.find((u) => u.id === line.unitId) ?? findBaseUnit(line.units);
}

/** One more or one less of the line's unit (never below one of that unit). */
export function bumpQty(cart: Cart, key: string, direction: 1 | -1): Cart {
  const line = cart.lines.find((l) => l.key === key);
  if (!line) return cart;
  const step = unitOf(line).qty;
  const qty = Math.max(step, line.qty + direction * step);
  return qty === line.qty ? cart : setQty(cart, key, qty);
}

/**
 * Switches the line between its sellable units, keeping the count: "2 Strips" becomes
 * "2 Boxes" or "2 Tablets". Used by ←/→ on the selected line.
 */
export function cycleUnit(cart: Cart, key: string, direction: 1 | -1): Cart {
  const line = cart.lines.find((l) => l.key === key);
  if (!line) return cart;
  const sellable = [...line.units].filter((u) => u.isSellable).sort((a, b) => a.qty - b.qty);
  if (sellable.length < 2) return cart;
  const current = unitOf(line);
  const index = Math.max(
    0,
    sellable.findIndex((u) => u.id === current.id),
  );
  const next = sellable[(index + direction + sellable.length) % sellable.length]!;
  const count = Math.max(1, Math.round(line.qty / current.qty));
  return setQty(cart, key, count * next.qty, next.id);
}

export function removeLine(cart: Cart, key: string, by: string, at: string, gross: Money): Cart {
  const index = cart.lines.findIndex((l) => l.key === key);
  if (index < 0) return cart;
  const line = cart.lines[index]!;
  const lines = cart.lines.filter((l) => l.key !== key);
  return {
    ...cart,
    lines,
    selectedKey: lines[Math.min(index, lines.length - 1)]?.key ?? null,
    removed: [
      ...cart.removed,
      { productId: line.productId, name: line.name, qty: line.qty, gross, at, by },
    ],
    undo: { line, index },
  };
}

/** Puts the last removed line back (and drops it from the removal log). */
export function undoRemove(cart: Cart): Cart {
  if (!cart.undo) return cart;
  const { line, index } = cart.undo;
  const lines = [...cart.lines];
  lines.splice(Math.min(index, lines.length), 0, line);
  return { ...cart, lines, selectedKey: line.key, removed: cart.removed.slice(0, -1), undo: null };
}

export function setLineDiscount(
  cart: Cart,
  key: string,
  discount: DiscountSpec | 'default' | 'none',
): Cart {
  return replaceLine(cart, key, (l) => ({ ...l, discount }));
}

export function setBillDiscount(cart: Cart, discount: DiscountSpec | null): Cart {
  return { ...cart, billDiscount: discount };
}

/** Picks batches by hand (null = back to automatic). The picks must add up to the line's quantity. */
export function pickBatches(
  cart: Cart,
  key: string,
  batches: { batchId: string; qty: number }[] | null,
): Cart {
  return replaceLine(cart, key, (l) => {
    if (batches && sumQty(batches) !== l.qty)
      throw new RangeError('picks must add up to the quantity');
    return { ...l, batches: batches && batches.length > 0 ? batches : null };
  });
}

export function setPrice(
  cart: Cart,
  key: string,
  price: PackPrice,
  source: CartLine['priceSource'],
  reason: string | null = null,
): Cart {
  return replaceLine(cart, key, (l) =>
    source === 'catalog'
      ? { ...l, price: l.listPrice, priceSource: 'catalog', priceReason: null }
      : { ...l, price, priceSource: source, priceReason: reason },
  );
}

export function confirmExpiredOnly(cart: Cart, key: string): Cart {
  return replaceLine(cart, key, (l) => ({ ...l, confirmedExpiredOnly: true }));
}

export function selectLine(cart: Cart, key: string | null): Cart {
  return { ...cart, selectedKey: key };
}

export function setRxCheck(cart: Cart, rxCheck: Cart['rxCheck']): Cart {
  return { ...cart, rxCheck };
}

export function setPrescription(cart: Cart, prescription: PrescriptionInput | null): Cart {
  return { ...cart, prescription };
}

export function toPricingLines(cart: Cart): PricingLine[] {
  return cart.lines.map((l) => ({
    key: l.key,
    price: l.price,
    qty: l.qty,
    taxRateBp: l.taxRateBp,
    allowDiscount: l.allowDiscount,
    discount: l.discount,
  }));
}

/**
 * The quantity as staff say it: "2 Strips", or "1 Strip, 2 Tablets" when it doesn't
 * fit the entered unit. Only sellable units are used for the breakdown.
 */
export function displayQty(line: Pick<CartLine, 'qty' | 'units' | 'unitId'>): string {
  const unit = line.units.find((u) => u.id === line.unitId);
  if (unit && line.qty % unit.qty === 0) {
    const n = line.qty / unit.qty;
    return `${n} ${pluralize(unit.name, n)}`;
  }
  const sellable = line.units.filter((u) => u.isSellable || u.qty === 1);
  return breakdownQty(line.qty, sortUnitsLargestFirst(sellable))
    .map(({ unit: u, count }) => `${count} ${pluralize(u.name, count)}`)
    .join(', ');
}

/** The unit a search hit is added in: the smallest sellable pack above one item, else the base. */
export function defaultSaleUnit(units: readonly CartUnit[], mode: 'strip' | 'base'): CartUnit {
  const sellable = [...units].filter((u) => u.isSellable).sort((a, b) => a.qty - b.qty);
  const base = sellable.find((u) => u.qty === 1) ?? sellable[0] ?? findBaseUnit(units);
  if (mode === 'base') return base;
  return sellable.find((u) => u.qty > 1) ?? base;
}
