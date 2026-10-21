import { describe, expect, it } from 'vitest';
import { formatDocNo, nextSeq, parseInvoiceQuery } from './invoice';
import { refundShare, refundTotal, splitReturnQty } from './returns-math';
import { PKR_NOTES, countTotal, expectedCash } from './shift-math';

const NEAREST = { step: 100, mode: 'nearest' } as const;

describe('returns', () => {
  it('refunds half of the Panadol line, then the rest of the sale exactly', () => {
    // Panadol line net 48020 for 20 tablets; return 10.
    const share = refundShare(48020, 20, 0, 0, 10);
    expect(share).toBe(24010);
    expect(
      refundTotal({
        refundNetBefore: 0,
        refundNetNow: share,
        isFinal: false,
        saleTotal: 196500,
        refundedBefore: 0,
        rule: NEAREST,
      }),
    ).toEqual({ total: 24000, rounding: -10 });
    // Returning everything else is final: exactly what's left of the total.
    expect(
      refundTotal({
        refundNetBefore: 24010,
        refundNetNow: 172529,
        isFinal: true,
        saleTotal: 196500,
        refundedBefore: 24000,
        rule: NEAREST,
      }),
    ).toEqual({ total: 172500, rounding: -29 });
    // Cost of the returned units.
    expect(refundShare(41650, 20, 0, 0, 10)).toBe(20825);
  });

  it('adds up exactly however a line is returned in pieces', () => {
    for (const total of [1, 999, 7370, 48020, 123457]) {
      for (const qty of [1, 3, 7, 20]) {
        let returned = 0;
        let refunded = 0;
        const pieces = [];
        while (returned < qty) {
          const n = Math.min(qty - returned, 1 + ((returned * 7 + total) % 3));
          const s = refundShare(total, qty, returned, refunded, n);
          pieces.push(s);
          returned += n;
          refunded += s;
        }
        expect(refunded).toBe(total);
        expect(pieces.every((p) => p >= 0)).toBe(true);
      }
    }
  });

  it('rounds partial refunds cumulatively', () => {
    // Two returns of Rs 0.60 each: rounded separately they'd be Re 1 + Re 1; cumulatively Re 1 + Re 0.
    const first = refundTotal({
      refundNetBefore: 0,
      refundNetNow: 60,
      isFinal: false,
      saleTotal: 1000,
      refundedBefore: 0,
      rule: NEAREST,
    });
    const second = refundTotal({
      refundNetBefore: 60,
      refundNetNow: 60,
      isFinal: false,
      saleTotal: 1000,
      refundedBefore: first.total,
      rule: NEAREST,
    });
    expect([first.total, second.total]).toEqual([100, 0]);
  });

  it('takes returns from the last allocation first', () => {
    const allocs = [
      { id: 'a', qty: 15, returned: 0 },
      { id: 'b', qty: 5, returned: 2 },
    ];
    expect(splitReturnQty(allocs, 4)).toEqual([
      { id: 'b', qty: 3 },
      { id: 'a', qty: 1 },
    ]);
    expect(() => splitReturnQty(allocs, 19)).toThrow();
  });

  it('rejects impossible returns', () => {
    expect(() => refundShare(100, 2, 1, 50, 2)).toThrow();
    expect(() => refundShare(100, 2, 0, 0, 0)).toThrow();
  });
});

describe('shift cash', () => {
  it('computes expected cash from the records', () => {
    // Float 5,000 + cash sale 965 − cash refund 240 − tea 150.
    expect(expectedCash(500000, 96500 - 24000, -15000)).toBe(557500);
  });

  it('totals a note count', () => {
    expect(countTotal({ notes: { '500000': 1, '50000': 1, '1000': 7 }, coins: 500 })).toBe(557500);
    expect(() => countTotal({ notes: { '300': 1 }, coins: 0 })).toThrow();
    expect(PKR_NOTES[0]).toBe(500000);
  });
});

describe('document numbers', () => {
  it('formats and continues numbering', () => {
    expect(formatDocNo('T1', 123)).toBe('T1-000123');
    expect(formatDocNo('T1', 12, 'R')).toBe('T1-R000012');
    expect(formatDocNo('T1', 1234567)).toBe('T1-1234567');
    expect(nextSeq(null, null)).toBe(1);
    expect(nextSeq(122, null)).toBe(123);
    expect(nextSeq(122, 500)).toBe(500);
    expect(nextSeq(600, 500)).toBe(601);
  });

  it('reads what staff type or scan', () => {
    expect(parseInvoiceQuery('123')).toEqual({ tillCode: null, seq: 123, isReturn: false });
    expect(parseInvoiceQuery('t1 123')).toEqual({ tillCode: 'T1', seq: 123, isReturn: false });
    expect(parseInvoiceQuery('T1-000123')).toEqual({ tillCode: 'T1', seq: 123, isReturn: false });
    expect(parseInvoiceQuery('T1000123')).toEqual({ tillCode: 'T1', seq: 123, isReturn: false });
    expect(parseInvoiceQuery('T1-R000012')).toEqual({ tillCode: 'T1', seq: 12, isReturn: true });
    expect(parseInvoiceQuery('panadol')).toBeNull();
  });
});
