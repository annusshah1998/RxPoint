import { pluralize } from './text';

/**
 * A pack size of a product. Stock is always counted in the base unit (qty = 1),
 * e.g. Tablet = 1, Strip = 10, Box = 30.
 */
export interface UnitDef {
  id?: string;
  name: string;
  /** How many base units one of these holds. */
  qty: number;
}

/** Largest unit first. */
export function sortUnitsLargestFirst<T extends UnitDef>(units: readonly T[]): T[] {
  return [...units].sort((a, b) => b.qty - a.qty);
}

export function findBaseUnit<T extends UnitDef>(units: readonly T[]): T {
  const base = units.find((unit) => unit.qty === 1);
  if (!base) throw new Error('A product needs a base unit with qty 1');
  return base;
}

export function toBaseQty(count: number, unit: UnitDef): number {
  return count * unit.qty;
}

/**
 * Splits a base quantity into whole units, largest first.
 * 47 tablets with Box = 30, Strip = 10 → 1 Box, 1 Strip, 7 Tablets.
 */
export function breakdownQty<T extends UnitDef>(
  baseQty: number,
  units: readonly T[],
): { unit: T; count: number }[] {
  let remaining = Math.abs(baseQty);
  const parts: { unit: T; count: number }[] = [];
  for (const unit of sortUnitsLargestFirst(units)) {
    const count = Math.floor(remaining / unit.qty);
    if (count > 0) {
      parts.push({ unit, count });
      remaining -= count * unit.qty;
    }
  }
  return parts;
}

/** "1 Box, 1 Strip, 7 Tablets". Zero shows as "0 Tablets"; negative stock gets a minus sign. */
export function formatQty(baseQty: number, units: readonly UnitDef[]): string {
  const base = findBaseUnit(units);
  if (baseQty === 0) return `0 ${pluralize(base.name, 0)}`;
  const text = breakdownQty(baseQty, units)
    .map(({ unit, count }) => `${count} ${pluralize(unit.name, count)}`)
    .join(', ');
  return baseQty < 0 ? `-(${text})` : text;
}

/**
 * "1 Box = 3 Strips = 30 Tablets": how many of each smaller unit make up the largest one.
 * Units that don't divide it evenly are left out.
 */
export function describeUnitLadder(units: readonly UnitDef[]): string {
  const sorted = sortUnitsLargestFirst(units);
  const largest = sorted[0];
  if (!largest || sorted.length === 1) return largest ? `1 ${largest.name}` : '';
  const parts = [`1 ${largest.name}`];
  for (const unit of sorted.slice(1)) {
    if (largest.qty % unit.qty === 0) {
      const count = largest.qty / unit.qty;
      parts.push(`${count} ${pluralize(unit.name, count)}`);
    }
  }
  return parts.join(' = ');
}
