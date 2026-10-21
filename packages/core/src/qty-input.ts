import { nameKey, pluralize } from './text';
import type { UnitDef } from './units';

export type QtyInputError = 'empty' | 'invalid' | 'unknown_unit' | 'ambiguous_unit' | 'zero';

export type QtyInputResult<T extends UnitDef> =
  | { ok: true; baseQty: number; parts: { unit: T; count: number }[] }
  | { ok: false; error: QtyInputError; detail?: string };

const ALLOWED = /^[\d\sa-z,+]+$/i;
const PART = /(\d+)\s*([a-z]*)/gi;

/**
 * Reads a quick quantity typed at the till.
 *   "3"        → 3 of the default unit
 *   "2s"       → 2 strips      ("2 strip", "2 str" also work)
 *   "1b 2s 5"  → 1 box + 2 strips + 5 of the default unit
 * A unit word matches when it is the start of a unit name (or its plural).
 */
export function parseQtyInput<T extends UnitDef>(
  input: string,
  units: readonly T[],
  defaultUnit: T,
): QtyInputResult<T> {
  const text = input.trim();
  if (!text) return { ok: false, error: 'empty' };
  if (!ALLOWED.test(text)) return { ok: false, error: 'invalid' };

  // Every character must belong to a "<number><unit?>" part.
  const leftover = text.replace(PART, '').replace(/[\s,+]/g, '');
  if (leftover) return { ok: false, error: 'invalid' };

  const parts: { unit: T; count: number }[] = [];
  for (const match of text.matchAll(PART)) {
    const count = Number(match[1]);
    const word = (match[2] ?? '').toLowerCase();
    const unit = word ? matchUnit(word, units) : { unit: defaultUnit };
    if ('error' in unit) return { ok: false, error: unit.error, detail: word };
    parts.push({ unit: unit.unit, count });
  }

  const baseQty = parts.reduce((sum, p) => sum + p.count * p.unit.qty, 0);
  if (!Number.isSafeInteger(baseQty)) return { ok: false, error: 'invalid' };
  if (baseQty === 0) return { ok: false, error: 'zero' };
  return { ok: true, baseQty, parts };
}

function matchUnit<T extends UnitDef>(
  word: string,
  units: readonly T[],
): { unit: T } | { error: 'unknown_unit' | 'ambiguous_unit' } {
  const names = (unit: T) => [nameKey(unit.name), nameKey(pluralize(unit.name, 2))];
  const exact = units.find((unit) => names(unit).includes(word));
  if (exact) return { unit: exact };
  const prefixed = units.filter((unit) => names(unit).some((name) => name.startsWith(word)));
  if (prefixed.length === 1) return { unit: prefixed[0]! };
  return { error: prefixed.length === 0 ? 'unknown_unit' : 'ambiguous_unit' };
}
