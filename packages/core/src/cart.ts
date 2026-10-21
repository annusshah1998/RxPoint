import { lineDiscountAmount, type DiscountSpec, type PricingLine } from './checkout';
import { percentOf, type Money } from './money';
import { priceForQty, type PackPrice } from './pricing';
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
  /**
   * For a controlled drug whose pack matches no recorded batch: the batch number and
   * expiry typed from the pack. A real batch is created for it when the sale completes.
   */
  packBatch: { batchNo: string; expiryDate: string; mrp: Money | null } | null;
  rx: RxKind;
  schedule: string | null;
  /** The cashier confirmed the packs in hand are in date (expired stock is on record). */
  confirmedInDate: boolean;
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

/**
 * The most base units one line may hold. Every barcode (6+ digits) is above it, so a
 * barcode typed into the quantity box can never become a quantity.
 */
export const MAX_LINE_QTY = 99_999;

/** Why a quantity can't go on a line, for the screen to say before changing the cart. */
export function lineQtyProblem(qty: number): 'zero' | 'too_large' | null {
  if (!Number.isSafeInteger(qty) || qty <= 0) return 'zero';
  return qty > MAX_LINE_QTY ? 'too_large' : null;
}

function assertQty(qty: number) {
  if (lineQtyProblem(qty)) throw new RangeError(`qty must be 1 to ${MAX_LINE_QTY}`);
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
  assertQty(qty);
  const existing = cart.lines.find((l) => l.productId === product.productId && canMerge(l));
  if (existing) {
    assertQty(existing.qty + qty);
    const merged = replaceLine(cart, existing.key, (l) => ({
      ...l,
      qty: l.qty + qty,
      confirmedInDate: false,
    }));
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
    packBatch: null,
    rx: product.rx,
    schedule: product.schedule,
    confirmedInDate: false,
  };
  return { ...cart, lines: [...cart.lines, line], selectedKey: key, undo: null };
}

/**
 * Sets a line's quantity (base units). A manual batch pick that no longer adds up is
 * cleared, and so is an "in date" confirmation (a new quantity needs a new answer).
 */
export function setQty(cart: Cart, key: string, qty: number, unitId?: string): Cart {
  assertQty(qty);
  return replaceLine(cart, key, (l) =>
    l.qty === qty && (unitId ?? l.unitId) === l.unitId
      ? l
      : {
          ...l,
          qty,
          unitId: unitId ?? l.unitId,
          batches: l.batches && sumQty(l.batches) === qty ? l.batches : null,
          confirmedInDate: l.qty === qty ? l.confirmedInDate : false,
        },
  );
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
    return {
      ...l,
      batches: batches && batches.length > 0 ? batches : null,
      packBatch: batches && batches.length > 0 ? null : l.packBatch,
    };
  });
}

/** For a controlled drug: the batch typed from the pack, when no recorded batch matches. */
export function setPackBatch(cart: Cart, key: string, packBatch: CartLine['packBatch']): Cart {
  return replaceLine(cart, key, (l) => ({
    ...l,
    packBatch,
    batches: packBatch ? null : l.batches,
  }));
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

export function confirmInDate(cart: Cart, key: string): Cart {
  return replaceLine(cart, key, (l) => ({ ...l, confirmedInDate: true }));
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

export type DroppedDiscount = { lineKey: string | null; reason: 'too_large' | 'not_discountable' };

/**
 * Drops discounts that no longer fit after a change: a fixed line discount larger than
 * the line, a fixed bill discount larger than the discountable total, or a discount on a
 * line that can't be discounted. Dropping is safer than clamping (clamping would make a
 * line free). Run after every change and on resume; the screen says what was dropped.
 */
export function normalizeCart(
  cart: Cart,
  settings: { defaultDiscountBp: number },
): { cart: Cart; dropped: DroppedDiscount[] } {
  const dropped: DroppedDiscount[] = [];
  let billBase = 0;
  const lines = cart.lines.map((l) => {
    const gross = priceForQty(l.price, l.qty);
    let discount = l.discount;
    if (typeof discount === 'object') {
      if (!l.allowDiscount) {
        dropped.push({ lineKey: l.key, reason: 'not_discountable' });
        discount = 'default';
      } else if (discount.kind === 'amount' && discount.amount > gross) {
        dropped.push({ lineKey: l.key, reason: 'too_large' });
        discount = 'default';
      }
    }
    if (l.allowDiscount) {
      const spec: DiscountSpec | null =
        discount === 'default'
          ? settings.defaultDiscountBp > 0
            ? { kind: 'percent', bp: settings.defaultDiscountBp }
            : null
          : discount === 'none'
            ? null
            : discount;
      billBase += gross - lineDiscountAmount(gross, spec);
    }
    return discount === l.discount ? l : { ...l, discount };
  });
  let billDiscount = cart.billDiscount;
  if (billDiscount?.kind === 'amount' && billDiscount.amount > billBase) {
    dropped.push({ lineKey: null, reason: 'too_large' });
    billDiscount = null;
  }
  if (dropped.length === 0) return { cart, dropped };
  return { cart: { ...cart, lines, billDiscount }, dropped };
}

/** The bill discount in money terms (for showing what a percent comes to). */
export function billDiscountPreview(base: Money, spec: DiscountSpec | null): Money {
  if (!spec) return 0;
  return spec.kind === 'percent' ? percentOf(base, spec.bp) : spec.amount;
}
