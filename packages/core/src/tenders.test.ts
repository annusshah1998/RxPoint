import { describe, expect, it } from 'vitest';
import { isSuspiciousTender, settleTenders, suggestCash } from './tenders';

describe('settleTenders', () => {
  it('splits card and cash and gives change from cash', () => {
    expect(
      settleTenders(196500, [
        { method: 'card', amount: 100000, reference: '4417' },
        { method: 'cash', tendered: 100000 },
      ]),
    ).toEqual({
      ok: true,
      cashApplied: 96500,
      change: 3500,
      payments: [
        {
          method: 'cash',
          amount: 96500,
          tendered: 100000,
          change: 3500,
          provider: null,
          reference: null,
        },
        {
          method: 'card',
          amount: 100000,
          tendered: null,
          change: null,
          provider: null,
          reference: '4417',
        },
      ],
    });
  });

  it('merges several cash entries', () => {
    const r = settleTenders(1500, [
      { method: 'cash', tendered: 1000 },
      { method: 'cash', tendered: 1000 },
    ]);
    expect(r.ok && r.payments).toEqual([
      {
        method: 'cash',
        amount: 1500,
        tendered: 2000,
        change: 500,
        provider: null,
        reference: null,
      },
    ]);
  });

  it('takes an exact wallet payment', () => {
    const r = settleTenders(5000, [
      { method: 'wallet', provider: 'jazzcash', amount: 5000, reference: ' 81726354 ' },
    ]);
    expect(r).toMatchObject({ ok: true, change: 0, cashApplied: 0 });
    expect(r.ok && r.payments[0]).toMatchObject({ provider: 'jazzcash', reference: '81726354' });
  });

  it('settles a zero bill with no payments', () => {
    expect(settleTenders(0, [])).toEqual({ ok: true, payments: [], cashApplied: 0, change: 0 });
  });

  it.each([
    ['short', 5000, [{ method: 'cash', tendered: 4000 }], { problem: 'short', short: 1000 }],
    [
      'card over total',
      5000,
      [{ method: 'card', amount: 6000 }],
      { problem: 'non_cash_over_total' },
    ],
    [
      'cash not needed',
      5000,
      [
        { method: 'card', amount: 5000 },
        { method: 'cash', tendered: 100 },
      ],
      { problem: 'cash_not_needed' },
    ],
    [
      'wallet without reference',
      5000,
      [{ method: 'wallet', provider: 'easypaisa', amount: 5000, reference: '12' }],
      { problem: 'wallet_reference', index: 0 },
    ],
    ['zero amount', 5000, [{ method: 'card', amount: 0 }], { problem: 'zero_amount', index: 0 }],
    ['khata', 5000, [{ method: 'khata', amount: 5000 }], { problem: 'khata_unavailable' }],
    ['nothing tendered', 5000, [], { problem: 'short', short: 5000 }],
  ] as const)('refuses %s', (_label, total, tenders, problem) => {
    expect(settleTenders(total, tenders as never)).toMatchObject({ ok: false, ...problem });
  });
});

describe('cash helpers', () => {
  it('suggests round amounts', () => {
    expect(suggestCash(96500)).toEqual([96500, 100000, 500000]);
    expect(suggestCash(100000)).toEqual([100000, 500000]);
    expect(suggestCash(1250)).toEqual([1250, 10000, 50000, 100000, 500000]);
    expect(suggestCash(0)).toEqual([]);
  });

  it('flags implausible tenders, like a barcode typed into the cash box', () => {
    expect(isSuspiciousTender(196500, 896400000000017)).toBe(true);
    expect(isSuspiciousTender(196500, 500000)).toBe(false);
    expect(isSuspiciousTender(5000, 100000)).toBe(true);
    expect(isSuspiciousTender(500, 5000)).toBe(false);
  });
});
