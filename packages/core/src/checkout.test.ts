import { describe, expect, it } from 'vitest';
import {
  PricingError,
  allocateProRata,
  allocationMrp,
  discountNeedBp,
  discountWithinCap,
  effectiveCapBp,
  extractTax,
  isAboveMrp,
  lineDiscountAmount,
  priceSale,
  roundBill,
  type PricingLine,
} from './checkout';

const NEAREST = { step: 100, mode: 'nearest' } as const;
const settings = { defaultDiscountBp: 0, rounding: NEAREST };

// The worked sale from docs/m2-design.md.
const worked: PricingLine[] = [
  // Panadol 500mg, Rs 735 per box of 30, "2s" = 20 tablets
  {
    key: 'L1',
    price: { amount: 73500, perQty: 30 },
    qty: 20,
    taxRateBp: 0,
    allowDiscount: true,
    discount: 'default',
  },
  // Brufen 400mg, Rs 245.67 per strip of 10, 3 tablets
  {
    key: 'L2',
    price: { amount: 24567, perQty: 10 },
    qty: 3,
    taxRateBp: 0,
    allowDiscount: true,
    discount: 'default',
  },
  // Augmentin 625mg, Rs 436.20 per strip of 6, "1s 2t" = 8 tablets, 10% off
  {
    key: 'L3',
    price: { amount: 43620, perQty: 6 },
    qty: 8,
    taxRateBp: 0,
    allowDiscount: true,
    discount: { kind: 'percent', bp: 1000 },
  },
  // Thermometer, never discounted, 18% tax
  {
    key: 'L4',
    price: { amount: 89999, perQty: 1 },
    qty: 1,
    taxRateBp: 1800,
    allowDiscount: false,
    discount: 'default',
  },
];

describe('priceSale', () => {
  it('prices the worked sale to the paisa', () => {
    const sale = priceSale(worked, { kind: 'percent', bp: 200 }, settings);
    expect(sale.lines.map((l) => [l.gross, l.lineDiscount, l.billShare, l.net, l.tax])).toEqual([
      [49000, 0, 980, 48020, 0],
      [7370, 0, 147, 7223, 0], // 3 × 24.57 would be 73.71; rounding once gives 73.70
      [58160, 5816, 1047, 51297, 0],
      [89999, 0, 0, 89999, 13729],
    ]);
    expect(sale).toMatchObject({
      grossTotal: 204529,
      lineDiscountTotal: 5816,
      billDiscount: 2174,
      billDiscountBp: 200,
      subtotal: 196539,
      rounding: -39,
      total: 196500,
      taxTotal: 13729,
      taxByRate: [{ rateBp: 1800, tax: 13729 }],
    });
    expect(sale.lines[2]).toMatchObject({ discountSource: 'manual', lineDiscountBp: 1000 });
    expect(sale.lines[0]!.discountSource).toBe('none');
  });

  it('applies the store default only to discountable lines', () => {
    const sale = priceSale(worked, null, { defaultDiscountBp: 500, rounding: NEAREST });
    expect(sale.lines.map((l) => [l.lineDiscount, l.discountSource])).toEqual([
      [2450, 'default'],
      [369, 'default'],
      [5816, 'manual'],
      [0, 'none'],
    ]);
  });

  it('refuses discounts it cannot give', () => {
    const noDisc: PricingLine = { ...worked[3]!, discount: { kind: 'percent', bp: 100 } };
    expect(() => priceSale([noDisc], null, settings)).toThrow(PricingError);
    const tooMuch: PricingLine = { ...worked[1]!, discount: { kind: 'amount', amount: 7371 } };
    expect(() => priceSale([tooMuch], null, settings)).toThrow('discount_exceeds');
    expect(() => priceSale(worked, { kind: 'amount', amount: 200_000 }, settings)).toThrow(
      'discount_exceeds',
    );
    expect(() => priceSale(worked, { kind: 'percent', bp: 10_001 }, settings)).toThrow(
      'invalid_discount',
    );
  });

  it('keeps its invariants on many random carts', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let run = 0; run < 2000; run++) {
      const lines: PricingLine[] = Array.from({ length: 1 + rand(8) }, (_, i) => {
        const allowDiscount = rand(5) > 0;
        return {
          key: `k${i}`,
          price: { amount: 1 + rand(200_000), perQty: 1 + rand(60) },
          qty: 1 + rand(100),
          taxRateBp: [0, 100, 1800][rand(3)]!,
          allowDiscount,
          discount:
            allowDiscount && rand(3) === 0 ? { kind: 'percent', bp: rand(2000) } : 'default',
        };
      });
      const anyDiscountable = lines.some((l) => l.allowDiscount);
      const bill = anyDiscountable && rand(2) ? { kind: 'percent' as const, bp: rand(1500) } : null;
      const sale = priceSale(lines, bill, { defaultDiscountBp: rand(2) * 500, rounding: NEAREST });
      expect(sale.lines.reduce((s, l) => s + l.billShare, 0)).toBe(sale.billDiscount);
      expect(sale.lines.every((l) => l.net >= 0 && l.tax >= 0 && l.tax <= l.net)).toBe(true);
      expect(sale.subtotal).toBe(sale.grossTotal - sale.lineDiscountTotal - sale.billDiscount);
      expect(sale.total).toBe(sale.subtotal + sale.rounding);
      expect(Math.abs(sale.rounding)).toBeLessThanOrEqual(50);
      expect(
        sale.lines.filter((l, i) => !lines[i]!.allowDiscount).every((l) => l.billShare === 0),
      ).toBe(true);
    }
  });
});

describe('pieces', () => {
  it('splits pro rata by largest remainder', () => {
    expect(allocateProRata(2174, [49000, 7370, 52344, 0])).toEqual([980, 147, 1047, 0]);
    expect(allocateProRata(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocateProRata(0, [5, 5])).toEqual([0, 0]);
    expect(allocateProRata(0, [0, 0])).toEqual([0, 0]);
    expect(() => allocateProRata(5, [0, 0])).toThrow();
    // Large values stay exact.
    const big = allocateProRata(900_000_000, [10_000_000_000, 20_000_000_000]);
    expect(big).toEqual([300_000_000, 600_000_000]);
  });

  it('extracts tax from inclusive prices', () => {
    expect(extractTax(89999, 1800)).toBe(13729);
    expect(extractTax(11800, 1800)).toBe(1800);
    expect(extractTax(10100, 100)).toBe(100);
    expect(extractTax(5000, 0)).toBe(0);
  });

  it('rounds bills', () => {
    expect(roundBill(48750, NEAREST)).toEqual({ total: 48800, rounding: 50 });
    expect(roundBill(48749, NEAREST)).toEqual({ total: 48700, rounding: -49 });
    expect(roundBill(48799, { step: 100, mode: 'down' })).toEqual({ total: 48700, rounding: -99 });
    expect(roundBill(48799, { step: 1, mode: 'nearest' })).toEqual({ total: 48799, rounding: 0 });
  });

  it('computes line discounts', () => {
    expect(lineDiscountAmount(58160, { kind: 'percent', bp: 1000 })).toBe(5816);
    expect(lineDiscountAmount(58160, { kind: 'amount', amount: 5000 })).toBe(5000);
    expect(lineDiscountAmount(58160, null)).toBe(0);
  });
});

describe('discount caps', () => {
  it('needs approval for 11.8% against a 5% cap', () => {
    // Augmentin line: 10% line discount + its bill share = 6863 on 58160.
    expect(discountWithinCap(6863, 58160, 500)).toBe(false);
    expect(discountNeedBp(6863, 58160)).toBe(1180);
    expect(discountWithinCap(6863, 58160, 1500)).toBe(true);
  });

  it('allows one paisa of rounding slack', () => {
    // 5% bill discount over Rs 49.99 + Rs 50.01 → shares of 250 each.
    const sale = priceSale(
      [
        {
          key: 'a',
          price: { amount: 4999, perQty: 1 },
          qty: 1,
          taxRateBp: 0,
          allowDiscount: true,
          discount: 'none',
        },
        {
          key: 'b',
          price: { amount: 5001, perQty: 1 },
          qty: 1,
          taxRateBp: 0,
          allowDiscount: true,
          discount: 'none',
        },
      ],
      { kind: 'percent', bp: 500 },
      { defaultDiscountBp: 0, rounding: { step: 1, mode: 'nearest' } },
    );
    expect(sale.lines.map((l) => l.billShare)).toEqual([250, 250]);
    expect(sale.lines.every((l) => discountWithinCap(l.billShare, l.gross, 500))).toBe(true);
    expect(discountNeedBp(250, 4999)).toBe(499);
  });

  it('never caps below the store default', () => {
    expect(effectiveCapBp(500, 1000)).toBe(1000);
    expect(effectiveCapBp(1500, 1000)).toBe(1500);
  });
});

describe('MRP', () => {
  it('flags a net above the batch MRP', () => {
    // Augmentin batch MRP Rs 415 per strip of 6; 8 tablets.
    const mrp = allocationMrp(8, { mrp: 41500, packQty: 6 });
    expect(mrp).toBe(55333);
    expect(isAboveMrp(58160, 8, { mrp: 55333, qty: 8 })).toBe(true); // Rs 28.27 over
    expect(isAboveMrp(51297, 8, { mrp: 55333, qty: 8 })).toBe(false); // after the 10% discount
    expect(allocationMrp(8, { mrp: null, packQty: 6 })).toBeNull();
  });

  it('scales to the allocations whose MRP is known', () => {
    // 10 sold, 6 from a batch with MRP 300 for those 6, 4 from one without MRP.
    expect(isAboveMrp(600, 10, { mrp: 300, qty: 6 })).toBe(true); // 60/unit vs 50/unit
    expect(isAboveMrp(500, 10, { mrp: 300, qty: 6 })).toBe(false);
    expect(isAboveMrp(500, 10, { mrp: 0, qty: 0 })).toBe(false);
  });
});
