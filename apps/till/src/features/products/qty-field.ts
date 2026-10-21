import { formatQty, parseQtyInput, type UnitDef } from '@app/core';
import { S } from '../../strings';

const QTY_ERRORS = {
  empty: S.validation.enterQuantity,
  invalid: S.validation.wholeNumbers,
  unknown_unit: S.validation.unknownUnit,
  ambiguous_unit: S.validation.ambiguousUnit,
  zero: S.validation.aboveZero,
} as const;

/** Reads a quantity field ("3", "2 strips", "1b 5t") into base units, with a preview. */
export function readQty(
  text: string,
  units: readonly (UnitDef & { id: string })[],
): { baseQty: number; preview: string } | { error: string } {
  const base = units.find((u) => u.qty === 1);
  if (!base) return { error: QTY_ERRORS.invalid };
  const result = parseQtyInput(text, units, base);
  if (!result.ok) {
    const message = QTY_ERRORS[result.error];
    return { error: result.detail ? `${message}: "${result.detail}"` : message };
  }
  return { baseQty: result.baseQty, preview: formatQty(result.baseQty, units) };
}
