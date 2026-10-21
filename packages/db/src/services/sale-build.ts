import {
  PricingError,
  allocateForSale,
  allocationCost,
  allocationMrp,
  applyParts,
  daysBetween,
  discountNeedBp,
  discountWithinCap,
  divRound,
  effectiveCapBp,
  formatExpiry,
  grantCovers,
  isAboveMrp,
  lineQtyProblem,
  normalizeCart,
  pluralize,
  priceForQty,
  priceSale,
  type Cart,
  type CartLine,
  type DroppedDiscount,
  type Grant,
  type IsoDate,
  type Money,
  type PackPrice,
  type PricedLine,
  type PricedSale,
  type SaleLot,
  type UserRole,
} from '@app/core';
import type { Db } from '../executor';
import type { BatchPick } from '../schema';
import type { Tx } from '../writes';
import type { StoreSettings } from './settings';

/*
 * Works out a sale from a cart and what the database says now: current prices, batches,
 * stock and approvals. Shared by planSale (the screen's live check) and completeSale, so
 * what the cashier sees is what gets recorded. Everything here is pure except loading.
 */

export interface LoadedProduct {
  id: string;
  /** "Panadol 500mg" */
  title: string;
  isActive: boolean;
  price: PackPrice;
  cost: PackPrice | null;
  taxClassId: string | null;
  taxRateBp: number;
  rxRequired: boolean;
  schedule: string | null;
  allowDiscount: boolean;
  units: { id: string; name: string; qty: number; isSellable: boolean }[];
}

export interface LoadedBatch {
  id: string;
  productId: string;
  batchNo: string;
  expiryDate: IsoDate | null;
  packQty: number;
  cost: Money | null;
  mrp: Money | null;
  placeholder: boolean;
  qty: number;
  createdAt: string;
}

export interface SaleData {
  products: Map<string, LoadedProduct>;
  batches: Map<string, LoadedBatch[]>;
}

/** Products, units, tax rates and batches (with stock) for the products in a cart. */
export async function loadSaleData(
  db: Db | Tx,
  branchId: string,
  productIds: readonly string[],
): Promise<SaleData> {
  const ids = [...new Set(productIds)];
  const products = new Map<string, LoadedProduct>();
  const batches = new Map<string, LoadedBatch[]>();
  if (ids.length === 0) return { products, batches };

  const rows = await db
    .selectFrom('product as p')
    .leftJoin('tax_class as t', 't.id', 'p.tax_class_id')
    .select([
      'p.id',
      'p.name',
      'p.strength',
      'p.is_active',
      'p.sale_price',
      'p.price_qty',
      'p.cost_price',
      'p.tax_class_id',
      't.rate_bp',
      'p.rx_required',
      'p.controlled_schedule',
      'p.allow_discount',
    ])
    .where('p.id', 'in', ids)
    .execute();
  const units = await db
    .selectFrom('product_unit')
    .select(['id', 'product_id', 'name', 'qty', 'is_sellable'])
    .where('product_id', 'in', ids)
    .where('is_active', '=', 1)
    .orderBy('qty')
    .execute();
  for (const r of rows) {
    products.set(r.id, {
      id: r.id,
      title: r.strength ? `${r.name} ${r.strength}` : r.name,
      isActive: r.is_active === 1,
      price: { amount: r.sale_price, perQty: r.price_qty },
      cost: r.cost_price === null ? null : { amount: r.cost_price, perQty: r.price_qty },
      taxClassId: r.tax_class_id,
      taxRateBp: r.rate_bp ?? 0,
      rxRequired: r.rx_required === 1,
      schedule: r.controlled_schedule,
      allowDiscount: r.allow_discount === 1,
      units: units
        .filter((u) => u.product_id === r.id)
        .map((u) => ({ id: u.id, name: u.name, qty: u.qty, isSellable: u.is_sellable === 1 })),
    });
  }

  const batchRows = await db
    .selectFrom('batch as b')
    .leftJoin('batch_stock as s', (join) =>
      join.onRef('s.batch_id', '=', 'b.id').on('s.branch_id', '=', branchId),
    )
    .select([
      'b.id',
      'b.product_id',
      'b.batch_no',
      'b.expiry_date',
      'b.pack_qty',
      'b.cost_price',
      'b.mrp',
      'b.is_placeholder',
      'b.created_at',
      's.qty',
    ])
    .where('b.product_id', 'in', ids)
    .execute();
  for (const b of batchRows) {
    const list = batches.get(b.product_id) ?? [];
    list.push({
      id: b.id,
      productId: b.product_id,
      batchNo: b.batch_no,
      expiryDate: b.expiry_date,
      packQty: b.pack_qty,
      cost: b.cost_price,
      mrp: b.mrp,
      placeholder: b.is_placeholder === 1,
      qty: b.qty ?? 0,
      createdAt: b.created_at,
    });
    batches.set(b.product_id, list);
  }
  return { products, batches };
}

export interface BuiltPart {
  /** null: the placeholder batch or a typed pack batch, created when the sale completes. */
  batchId: string | null;
  /** Set for a controlled drug's batch typed from the pack, when it isn't on record. */
  newPackBatch: { batchNo: string; expiryDate: IsoDate; mrp: Money | null } | null;
  placeholder: boolean;
  qty: number;
  pick: BatchPick;
  stockBefore: number;
  batchNo: string;
  expiryDate: IsoDate | null;
  /** Cost of these units, where known. */
  cost: Money | null;
  /** The MRP of these units, where the batch has one. */
  mrp: Money | null;
  /** Batch MRP per pack (for "sell at MRP"). */
  mrpPrice: PackPrice | null;
}

export interface BuiltLine {
  index: number;
  key: string;
  line: CartLine;
  product: LoadedProduct;
  /** The price charged and where it came from. */
  price: PackPrice;
  priceSource: 'catalog' | 'mrp';
  parts: BuiltPart[];
  priced: PricedLine | null;
  cost: Money | null;
  aboveMrp: { mrpPrice: PackPrice; over: Money } | null;
  /** Who approved this line's discount, when someone had to. */
  discountApprovedBy: string | null;
}

export type SaleWarning =
  | { kind: 'past_zero'; lineKey: string; recorded: number; qty: number }
  | {
      kind: 'expired_on_record';
      lineKey: string;
      inDate: number;
      shortfall: number;
      expiredQty: number;
      batches: { batchNo: string; expiryDate: IsoDate; qty: number }[];
      confirmed: boolean;
    }
  | { kind: 'above_mrp'; lineKey: string; mrpPrice: PackPrice; over: Money }
  | { kind: 'near_expiry'; lineKey: string; batchNo: string; expiryDate: IsoDate; days: number }
  | { kind: 'rx'; lineKeys: string[] }
  | { kind: 'controlled'; lineKeys: string[] }
  | { kind: 'price_changed'; lineKey: string; price: PackPrice }
  | { kind: 'discount_dropped'; lineKey: string | null; reason: DroppedDiscount['reason'] }
  | { kind: 'clock_behind'; message: string };

export type ApprovalNeed =
  | { kind: 'sale.discount'; lineKey: string; needBp: number }
  | { kind: 'sale.controlled'; lineKey: '' };

export interface ExpiryCheck {
  key: string;
  inDate: number;
  shortfall: number;
  expiredQty: number;
  expiredBatches: { batchNo: string; expiryDate: IsoDate; qty: number }[];
}

export interface SaleBuild {
  cart: Cart;
  dropped: DroppedDiscount[];
  lines: BuiltLine[];
  priced: PricedSale | null;
  /** Problems with the cart, keyed by form path (lines.0.qty …). */
  fields: Record<string, string>;
  /** Something this version can't do (price changes). */
  notAvailable: string | null;
  /** Lines whose packs must be confirmed in date (expired stock on record). */
  confirm: ExpiryCheck[];
  needs: ApprovalNeed[];
  warnings: SaleWarning[];
  /** Problems to fix at Pay: the Rx answer and the prescription. */
  payFields: Record<string, string>;
  billDiscountApprovedBy: string | null;
  /** Who dispenses the controlled lines (the actor, or the approving pharmacist). */
  dispensedBy: string | null;
  costTotal: Money | null;
  rxCheck: 'none' | 'seen' | 'not_seen';
}

export interface BuildContext {
  cart: Cart;
  data: SaleData;
  settings: StoreSettings;
  /** The date expiry is checked against (never before the last record). */
  expiryToday: IsoDate;
  actor: { id: string; role: UserRole; canControlled: boolean };
  grants: Grant[];
}

function baseUnitName(product: LoadedProduct, n: number): string {
  const base = product.units.find((u) => u.qty === 1);
  return pluralize(base?.name ?? 'unit', n);
}

function lowestMrp(parts: readonly BuiltPart[]): PackPrice | null {
  let best: PackPrice | null = null;
  for (const p of parts) {
    if (!p.mrpPrice) continue;
    // a/b < c/d  ⇔  a·d < c·b
    if (!best || p.mrpPrice.amount * best.perQty < best.amount * p.mrpPrice.perQty) {
      best = p.mrpPrice;
    }
  }
  return best;
}

const samePrice = (a: PackPrice, b: PackPrice) => a.amount === b.amount && a.perQty === b.perQty;

export function buildSale(input: BuildContext): SaleBuild {
  const { data, settings, expiryToday, actor } = input;
  const { cart, dropped } = normalizeCart(input.cart, settings);
  const fields: Record<string, string> = {};
  const payFields: Record<string, string> = {};
  const warnings: SaleWarning[] = dropped.map((d) => ({
    kind: 'discount_dropped' as const,
    lineKey: d.lineKey,
    reason: d.reason,
  }));
  const confirm: ExpiryCheck[] = [];
  const needs: ApprovalNeed[] = [];
  let notAvailable: string | null = null;

  // Working copy of each product's lots, shared by its lines.
  const lots = new Map<string, SaleLot[]>();
  const lotsFor = (productId: string): SaleLot[] => {
    let list = lots.get(productId);
    if (!list) {
      list = (data.batches.get(productId) ?? []).map((b) => ({
        batchId: b.id,
        expiryDate: b.expiryDate,
        qty: b.qty,
        receivedAt: b.createdAt,
        placeholder: b.placeholder,
      }));
      lots.set(productId, list);
    }
    return list;
  };
  const batchOf = (productId: string, id: string | null) =>
    (data.batches.get(productId) ?? []).find((b) => (id === null ? b.placeholder : b.id === id));

  const built: BuiltLine[] = [];
  cart.lines.forEach((line, index) => {
    const at = `lines.${index}`;
    const product = data.products.get(line.productId);
    if (!product || !product.isActive) {
      fields[`${at}.productId`] = 'Archived — ask the owner';
      return;
    }
    const unit = product.units.find((u) => u.id === line.unitId);
    if (!unit || !unit.isSellable) {
      fields[`${at}.qty`] = 'This pack size can’t be sold';
      return;
    }
    const qtyProblem = lineQtyProblem(line.qty);
    if (qtyProblem) {
      fields[`${at}.qty`] =
        qtyProblem === 'zero'
          ? 'Enter a quantity'
          : `At most 99,999 ${baseUnitName(product, 2)} on one line`;
      return;
    }
    if (line.priceSource === 'override') {
      notAvailable = 'Price changes come later — sell at the catalog price or MRP';
    }
    if (typeof line.discount === 'object' && !product.allowDiscount) {
      fields[`${at}.discount`] = 'No discount on this item';
    }
    const controlled = product.schedule !== null;

    // ---- Batches ----
    const productLots = lotsFor(line.productId);
    let parts: BuiltPart[];
    const toPart = (
      p: {
        batchId: string | null;
        qty: number;
        pick: BatchPick;
        stockBefore: number;
      },
      placeholder: boolean,
    ): BuiltPart => {
      const batch = batchOf(line.productId, p.batchId);
      const packQty = batch?.packQty ?? product.price.perQty;
      return {
        batchId: batch?.id ?? null,
        newPackBatch: null,
        placeholder,
        qty: p.qty,
        pick: p.pick,
        stockBefore: p.stockBefore,
        batchNo: batch?.batchNo ?? '',
        expiryDate: batch?.expiryDate ?? null,
        cost: allocationCost(
          p.qty,
          { cost: batch?.cost ?? null, packQty },
          product.cost,
          placeholder,
        ).cost,
        mrp: batch && !placeholder ? allocationMrp(p.qty, { mrp: batch.mrp, packQty }) : null,
        mrpPrice:
          batch && !placeholder && batch.mrp !== null
            ? { amount: batch.mrp, perQty: batch.packQty }
            : null,
      };
    };

    if (line.packBatch) {
      const pb = line.packBatch;
      if (!controlled) {
        fields[`${at}.packBatch.expiryDate`] = 'Only for controlled drugs';
        return;
      }
      if (pb.expiryDate < expiryToday) {
        fields[`${at}.packBatch.expiryDate`] =
          `This pack expired (${formatExpiry(pb.expiryDate)}) — cannot be sold`;
        return;
      }
      const existing = (data.batches.get(line.productId) ?? []).find(
        (b) =>
          !b.placeholder &&
          b.batchNo.toLowerCase() === pb.batchNo.trim().toLowerCase() &&
          b.expiryDate === pb.expiryDate,
      );
      const lot = existing && productLots.find((l) => l.batchId === existing.id);
      if (existing && lot) {
        lots.set(
          line.productId,
          applyParts(productLots, [
            { batchId: existing.id, qty: line.qty, pick: 'manual', stockBefore: lot.qty },
          ]),
        );
      }
      parts = [
        existing
          ? toPart(
              { batchId: existing.id, qty: line.qty, pick: 'manual', stockBefore: lot!.qty },
              false,
            )
          : {
              batchId: null,
              newPackBatch: { batchNo: pb.batchNo.trim(), expiryDate: pb.expiryDate, mrp: pb.mrp },
              placeholder: false,
              qty: line.qty,
              pick: 'manual',
              stockBefore: 0,
              batchNo: pb.batchNo.trim(),
              expiryDate: pb.expiryDate,
              cost: product.cost ? priceForQty(product.cost, line.qty) : null,
              mrp:
                pb.mrp === null
                  ? null
                  : priceForQty({ amount: pb.mrp, perQty: product.price.perQty }, line.qty),
              mrpPrice: pb.mrp === null ? null : { amount: pb.mrp, perQty: product.price.perQty },
            },
      ];
    } else {
      if (controlled && !line.batches) {
        fields[`${at}.batches`] = 'Pick the batch printed on the pack';
        return;
      }
      const result = allocateForSale(productLots, line.qty, {
        today: expiryToday,
        manual: line.batches,
      });
      if (!result.ok) {
        const j = line.batches?.findIndex((b) => b.batchId === result.batchId) ?? -1;
        const batch = result.batchId ? batchOf(line.productId, result.batchId) : undefined;
        if (result.error === 'expired' && batch) {
          fields[`${at}.batches.${j}.batchId`] =
            `Batch ${batch.batchNo || '(no number)'} expired (${formatExpiry(batch.expiryDate!)}) — cannot be sold`;
        } else if (result.error === 'unknown_batch') {
          fields[`${at}.batches.${j}.batchId`] = 'This batch is not on record for this item';
        } else {
          fields[`${at}.batches`] = 'The batches must add up to the quantity';
        }
        return;
      }
      parts = result.parts.map((p) => toPart(p, p.pick === 'unrecorded'));
      lots.set(line.productId, applyParts(productLots, result.parts));

      const recorded = productLots
        .filter((l) => !l.placeholder && l.qty > 0)
        .filter((l) => l.expiryDate === null || l.expiryDate >= expiryToday)
        .reduce((s, l) => s + l.qty, 0);
      const pastZero =
        result.shortfall > 0 || parts.some((p) => !p.placeholder && p.stockBefore < p.qty);
      if (pastZero)
        warnings.push({ kind: 'past_zero', lineKey: line.key, recorded, qty: line.qty });
      if (result.needsExpiryCheck) {
        const expiredBatches = productLots
          .filter(
            (l) =>
              !l.placeholder && l.qty > 0 && l.expiryDate !== null && l.expiryDate < expiryToday,
          )
          .map((l) => {
            const b = batchOf(line.productId, l.batchId)!;
            return { batchNo: b.batchNo, expiryDate: b.expiryDate!, qty: l.qty };
          });
        const check = {
          key: line.key,
          inDate: line.qty - result.shortfall,
          shortfall: result.shortfall,
          expiredQty: result.expiredQty,
          expiredBatches,
        };
        warnings.push({
          kind: 'expired_on_record',
          lineKey: line.key,
          inDate: check.inDate,
          shortfall: check.shortfall,
          expiredQty: check.expiredQty,
          batches: expiredBatches,
          confirmed: line.confirmedInDate,
        });
        if (!line.confirmedInDate) confirm.push(check);
      }
    }

    for (const p of parts) {
      if (!p.expiryDate || p.placeholder) continue;
      const days = daysBetween(expiryToday, p.expiryDate);
      if (days >= 0 && days <= settings.saleNearExpiryDays) {
        warnings.push({
          kind: 'near_expiry',
          lineKey: line.key,
          batchNo: p.batchNo,
          expiryDate: p.expiryDate,
          days,
        });
      }
    }

    // ---- Price ----
    let price = product.price;
    let priceSource: 'catalog' | 'mrp' = 'catalog';
    if (line.priceSource === 'mrp') {
      const mrp = lowestMrp(parts);
      if (mrp) {
        price = mrp;
        priceSource = 'mrp';
      }
    }
    if (!samePrice(price, line.price)) {
      warnings.push({ kind: 'price_changed', lineKey: line.key, price });
    }
    if (typeof line.discount === 'object' && line.discount.kind === 'amount') {
      if (line.discount.amount > priceForQty(price, line.qty)) {
        fields[`${at}.discount`] = 'More than the line amount';
      }
    }

    const cost = parts.some((p) => p.cost === null) ? null : parts.reduce((s, p) => s + p.cost!, 0);
    built.push({
      index,
      key: line.key,
      line,
      product,
      price,
      priceSource,
      parts,
      priced: null,
      cost,
      aboveMrp: null,
      discountApprovedBy: null,
    });
  });

  // ---- Pricing (only when every line is sound) ----
  let priced: PricedSale | null = null;
  if (Object.keys(fields).length === 0 && built.length === cart.lines.length && built.length > 0) {
    try {
      priced = priceSale(
        built.map((b) => ({
          key: b.key,
          price: b.price,
          qty: b.line.qty,
          taxRateBp: b.product.taxRateBp,
          allowDiscount: b.product.allowDiscount,
          discount: b.line.discount,
        })),
        cart.billDiscount,
        settings,
      );
    } catch (error) {
      if (!(error instanceof PricingError)) throw error;
      const i = built.findIndex((b) => b.key === error.lineKey);
      if (i >= 0) fields[`lines.${built[i]!.index}.discount`] = 'This discount doesn’t fit';
      else fields.billDiscount = 'More than the bill';
    }
  }

  let billDiscountApprovedBy: string | null = null;
  if (priced) {
    const cap = effectiveCapBp(settings.discountCapBp[actor.role], settings.defaultDiscountBp);
    const billGrant = input.grants.find((g) => g.kind === 'sale.discount' && g.lineKey === '');
    let billNeed = 0;
    priced.lines.forEach((p, i) => {
      const b = built[i]!;
      b.priced = p;
      // Above MRP: what the customer pays against the MRP of the units sold.
      const known = b.parts.reduce(
        (acc, part) =>
          part.mrp === null ? acc : { mrp: acc.mrp + part.mrp, qty: acc.qty + part.qty },
        { mrp: 0, qty: 0 },
      );
      const mrpPrice = lowestMrp(b.parts);
      if (mrpPrice && isAboveMrp(p.net, b.line.qty, known)) {
        const over = p.net - divRound(known.mrp * b.line.qty, known.qty);
        b.aboveMrp = { mrpPrice, over };
        warnings.push({ kind: 'above_mrp', lineKey: b.key, mrpPrice, over });
      }
      // Discount caps.
      const d = p.lineDiscount + p.billShare;
      if (d === 0 || discountWithinCap(d, p.gross, cap)) return;
      const lineGrant = input.grants.find((g) => g.kind === 'sale.discount' && g.lineKey === b.key);
      const amounts = { discount: d, gross: p.gross };
      if (lineGrant && grantCovers(lineGrant, cart, actor.id, amounts)) {
        b.discountApprovedBy = lineGrant.approverId;
        return;
      }
      if (billGrant && grantCovers(billGrant, cart, actor.id, amounts)) {
        b.discountApprovedBy = billGrant.approverId;
        billDiscountApprovedBy = billGrant.approverId;
        return;
      }
      const need = discountNeedBp(d, p.gross);
      if (!discountWithinCap(p.lineDiscount, p.gross, cap)) {
        needs.push({ kind: 'sale.discount', lineKey: b.key, needBp: need });
      } else {
        billNeed = Math.max(billNeed, need);
      }
    });
    if (billNeed > 0) needs.push({ kind: 'sale.discount', lineKey: '', needBp: billNeed });
  }

  // ---- Prescriptions ----
  const rxLines = built.filter((b) => b.product.rxRequired && b.product.schedule === null);
  const controlledLines = built.filter((b) => b.product.schedule !== null);
  if (rxLines.length > 0) {
    warnings.push({ kind: 'rx', lineKeys: rxLines.map((b) => b.key) });
    if (!cart.rxCheck) payFields.rxCheck = 'Was the prescription seen?';
    else if (cart.rxCheck === 'not_seen' && settings.rxCheck === 'require_seen') {
      payFields.rxCheck = 'This store needs the prescription to be seen';
    }
  }
  let dispensedBy: string | null = null;
  if (controlledLines.length > 0) {
    warnings.push({ kind: 'controlled', lineKeys: controlledLines.map((b) => b.key) });
    if (!cart.prescription?.patientName?.trim()) {
      payFields['prescription.patientName'] = 'Enter the patient’s name';
    }
    if (!cart.prescription?.prescriberName?.trim()) {
      payFields['prescription.prescriberName'] = 'Enter the doctor’s name';
    }
    if (actor.canControlled) {
      dispensedBy = actor.id;
    } else {
      const grant = input.grants.find((g) => g.kind === 'sale.controlled' && g.lineKey === '');
      if (grant && grantCovers(grant, cart, actor.id)) dispensedBy = grant.approverId;
      else needs.push({ kind: 'sale.controlled', lineKey: '' });
    }
  }

  const costTotal =
    built.length > 0 && built.every((b) => b.cost !== null)
      ? built.reduce((s, b) => s + b.cost!, 0)
      : null;
  return {
    cart,
    dropped,
    lines: built,
    priced,
    fields,
    notAvailable,
    confirm,
    needs,
    warnings,
    payFields,
    billDiscountApprovedBy,
    dispensedBy,
    costTotal,
    rxCheck:
      rxLines.length > 0
        ? (cart.rxCheck ?? 'not_seen')
        : controlledLines.length > 0
          ? 'seen'
          : 'none',
  };
}
