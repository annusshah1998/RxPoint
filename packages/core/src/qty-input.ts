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

/**
 * What was typed in the sale screen's scan box. A quantity can be put in front with a
 * star: "2s*pana" (2 strips of the first match), "3*8964000000017" (3 of a scanned pack).
 */
export function parseScanInput(input: string): { qtyText: string | null; term: string } {
  const text = input.trim();
  const star = text.indexOf('*');
  if (star > 0) {
    const qtyText = text.slice(0, star).trim();
    const term = text.slice(star + 1).trim();
    if (qtyText && term && /^[\d\sa-z,+]+$/i.test(qtyText) && /\d/.test(qtyText)) {
      return { qtyText, term };
    }
  }
  return { qtyText: null, term: text };
}

/** Barcodes are 6–14 digits (EAN-8, EAN-13, GTIN-14, in-store codes). */
export function looksLikeBarcode(text: string): boolean {
  return /^\d{6,14}$/.test(text.trim());
}

export type DiscountInput =
  | { kind: 'none' }
  | { kind: 'percent'; bp: number }
  | { kind: 'amount'; amount: number }
  | { kind: 'invalid' };

/**
 * A discount as typed: "10" or "10%" → 10%; "12.5%" → 12.5%; "50/-", "rs50", "Rs 50" →
 * Rs 50 off; "0" or blank → none. Over 100% is invalid.
 */
export function parseDiscountInput(input: string): DiscountInput {
  const text = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!text || text === '0' || text === '0%') return { kind: 'none' };
  let m = /^rs\.?(\d+(?:\.\d{1,2})?)$/.exec(text) ?? /^(\d+(?:\.\d{1,2})?)\/-$/.exec(text);
  if (m) {
    const [whole, frac = ''] = m[1]!.split('.');
    const amount = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
    return amount > 0 ? { kind: 'amount', amount } : { kind: 'none' };
  }
  m = /^(\d+(?:\.\d{1,2})?)%?$/.exec(text);
  if (m) {
    const [whole, frac = ''] = m[1]!.split('.');
    const bp = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
    if (bp > 10_000) return { kind: 'invalid' };
    return bp > 0 ? { kind: 'percent', bp } : { kind: 'none' };
  }
  return { kind: 'invalid' };
}
