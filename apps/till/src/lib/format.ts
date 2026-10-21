import {
  PRODUCT_FORM_LABELS,
  formatMoney,
  pluralize,
  type ExpiryStatus,
  type Money,
  type ProductForm,
  type UnitDef,
} from '@app/core';
import type { Tone } from '../ui';
import { S } from '../strings';

/** "Panadol 500mg" */
export function productTitle(product: { name: string; strength: string | null }): string {
  return product.strength ? `${product.name} ${product.strength}` : product.name;
}

export function formLabel(form: string): string {
  return PRODUCT_FORM_LABELS[form as ProductForm] ?? form;
}

/** The name of the unit holding `qty` base units, or "30 Tablets" if there isn't one. */
export function unitLabel(units: readonly UnitDef[], qty: number): string {
  const unit = units.find((u) => u.qty === qty);
  if (unit) return unit.name;
  const base = units.find((u) => u.qty === 1);
  return `${qty} ${pluralize(base?.name ?? 'unit', qty)}`;
}

/** "Rs 735.00 / Box" */
export function formatPackPrice(amount: Money, perQty: number, units: readonly UnitDef[]): string {
  return `${formatMoney(amount)} / ${unitLabel(units, perQty)}`;
}

export const EXPIRY_TONE: Record<ExpiryStatus, Tone> = {
  expired: 'bad',
  near: 'warn',
  ok: 'good',
  none: 'neutral',
};

export const EXPIRY_LABEL: Record<ExpiryStatus, string> = {
  expired: S.expiry.expired,
  near: S.expiry.near,
  ok: S.expiry.ok,
  none: S.expiry.none,
};
