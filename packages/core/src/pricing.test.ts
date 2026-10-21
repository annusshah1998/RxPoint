import { describe, expect, it } from 'vitest';
import { marginBasisPoints, pricePerUnit, priceForQty } from './pricing';

const stripPrice = { amount: 24567, perQty: 10 }; // Rs 245.67 per strip of 10

describe('priceForQty', () => {
  it('prices loose tablets from the pack price, rounding once', () => {
    expect(priceForQty(stripPrice, 1)).toBe(2457);
    expect(priceForQty(stripPrice, 3)).toBe(7370); // not 3 × 24.57 = 73.71
    expect(priceForQty(stripPrice, 10)).toBe(24567);
    expect(priceForQty(stripPrice, 30)).toBe(73701);
  });

  it('handles returns as negative quantities', () => {
    expect(priceForQty(stripPrice, -3)).toBe(-7370);
  });

  it('rejects bad input', () => {
    expect(() => priceForQty(stripPrice, 1.5)).toThrow();
    expect(() => priceForQty({ amount: 100, perQty: 0 }, 1)).toThrow();
  });
});

describe('pricePerUnit', () => {
  it('lists the price of each pack size, largest first', () => {
    const units = [
      { name: 'Tablet', qty: 1 },
      { name: 'Strip', qty: 10 },
      { name: 'Box', qty: 30 },
    ];
    expect(pricePerUnit({ amount: 73500, perQty: 30 }, units).map((p) => p.amount)).toEqual([
      73500, 24500, 2450,
    ]);
  });
});

describe('marginBasisPoints', () => {
  it('compares prices quoted for different pack sizes', () => {
    // Sells at Rs 245 per strip of 10, bought at Rs 588 per box of 30 → cost Rs 196 per strip.
    expect(marginBasisPoints({ amount: 24500, perQty: 10 }, { amount: 58800, perQty: 30 })).toBe(
      2000,
    );
  });

  it('returns null when a price is missing', () => {
    expect(marginBasisPoints(null, stripPrice)).toBeNull();
    expect(marginBasisPoints({ amount: 0, perQty: 1 }, stripPrice)).toBeNull();
  });
});
