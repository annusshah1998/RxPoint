import { describe, expect, it } from 'vitest';
import { parseQtyInput } from './qty-input';

const tablet = { name: 'Tablet', qty: 1 };
const strip = { name: 'Strip', qty: 10 };
const box = { name: 'Box', qty: 30 };
const units = [tablet, strip, box];

function qty(input: string, defaultUnit = tablet) {
  const result = parseQtyInput(input, units, defaultUnit);
  return result.ok ? result.baseQty : result.error;
}

describe('parseQtyInput', () => {
  it('uses the default unit for bare numbers', () => {
    expect(qty('3')).toBe(3);
    expect(qty('3', strip)).toBe(30);
  });

  it('understands unit shortcuts and words', () => {
    expect(qty('2s')).toBe(20);
    expect(qty('2 strips')).toBe(20);
    expect(qty('2 STR')).toBe(20);
    expect(qty('5t')).toBe(5);
    expect(qty('1 box')).toBe(30);
    expect(qty('2 boxes')).toBe(60);
  });

  it('adds up several parts', () => {
    expect(qty('1b 2s 5')).toBe(55);
    expect(qty('1b+2s')).toBe(50);
    expect(qty('1b, 3t')).toBe(33);
  });

  it('reports problems', () => {
    expect(qty('')).toBe('empty');
    expect(qty('-2')).toBe('invalid');
    expect(qty('2.5')).toBe('invalid');
    expect(qty('two')).toBe('invalid');
    expect(qty('2x')).toBe('unknown_unit');
    expect(qty('0')).toBe('zero');
  });

  it('refuses to guess between units with the same prefix', () => {
    const bottleUnits = [
      { name: 'Bottle', qty: 1 },
      { name: 'Box', qty: 12 },
    ];
    const result = parseQtyInput('2b', bottleUnits, bottleUnits[0]!);
    expect(result).toEqual({ ok: false, error: 'ambiguous_unit', detail: 'b' });
    const exact = parseQtyInput('1 box', bottleUnits, bottleUnits[0]!);
    expect(exact.ok && exact.baseQty).toBe(12);
  });
});
