import { describe, expect, it } from 'vitest';
import { breakdownQty, describeUnitLadder, findBaseUnit, formatQty } from './units';

const tablet = { name: 'Tablet', qty: 1 };
const strip = { name: 'Strip', qty: 10 };
const box = { name: 'Box', qty: 30 };
const units = [tablet, strip, box];

describe('units', () => {
  it('finds the base unit', () => {
    expect(findBaseUnit(units)).toBe(tablet);
    expect(() => findBaseUnit([strip])).toThrow();
  });

  it('breaks a quantity into whole units', () => {
    expect(breakdownQty(47, units)).toEqual([
      { unit: box, count: 1 },
      { unit: strip, count: 1 },
      { unit: tablet, count: 7 },
    ]);
    expect(breakdownQty(60, units)).toEqual([{ unit: box, count: 2 }]);
  });

  it('formats quantities for people', () => {
    expect(formatQty(47, units)).toBe('1 Box, 1 Strip, 7 Tablets');
    expect(formatQty(2, units)).toBe('2 Tablets');
    expect(formatQty(0, units)).toBe('0 Tablets');
    expect(formatQty(-12, units)).toBe('-(1 Strip, 2 Tablets)');
    expect(
      formatQty(90, [
        { name: 'Box', qty: 30 },
        { name: 'Tablet', qty: 1 },
      ]),
    ).toBe('3 Boxes');
  });

  it('describes the pack ladder', () => {
    expect(describeUnitLadder(units)).toBe('1 Box = 3 Strips = 30 Tablets');
    expect(describeUnitLadder([tablet])).toBe('1 Tablet');
    expect(describeUnitLadder([tablet, { name: 'Strip', qty: 14 }, { name: 'Box', qty: 30 }])).toBe(
      '1 Box = 30 Tablets',
    );
  });
});
