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

describe('scan box input', () => {
  it('splits a quantity prefix from the search', async () => {
    const { parseScanInput, looksLikeBarcode } = await import('./qty-input');
    expect(parseScanInput('2s*pana')).toEqual({ qtyText: '2s', term: 'pana' });
    expect(parseScanInput('3*8964000000017')).toEqual({ qtyText: '3', term: '8964000000017' });
    expect(parseScanInput('panadol')).toEqual({ qtyText: null, term: 'panadol' });
    expect(parseScanInput('*pana')).toEqual({ qtyText: null, term: '*pana' });
    expect(parseScanInput('x*pana')).toEqual({ qtyText: null, term: 'x*pana' });
    expect(looksLikeBarcode('8964000000017')).toBe(true);
    expect(looksLikeBarcode('12345')).toBe(false);
    expect(looksLikeBarcode('pan123456')).toBe(false);
  });

  it('reads discounts as typed', async () => {
    const { parseDiscountInput } = await import('./qty-input');
    expect(parseDiscountInput('10')).toEqual({ kind: 'percent', bp: 1000 });
    expect(parseDiscountInput('12.5%')).toEqual({ kind: 'percent', bp: 1250 });
    expect(parseDiscountInput('50/-')).toEqual({ kind: 'amount', amount: 5000 });
    expect(parseDiscountInput('Rs 50')).toEqual({ kind: 'amount', amount: 5000 });
    expect(parseDiscountInput('rs.12.50')).toEqual({ kind: 'amount', amount: 1250 });
    expect(parseDiscountInput('')).toEqual({ kind: 'none' });
    expect(parseDiscountInput('0')).toEqual({ kind: 'none' });
    expect(parseDiscountInput('101%')).toEqual({ kind: 'invalid' });
    expect(parseDiscountInput('ten')).toEqual({ kind: 'invalid' });
  });
});
