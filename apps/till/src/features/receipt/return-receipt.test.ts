import type { ReturnReceiptData } from '@app/db';
import { decodeEscPos, renderEscPos, renderText } from '@app/receipt';
import { describe, expect, it } from 'vitest';
import { returnReceipt } from './return-receipt';

/** The first return of the worked sale (docs/m2-design.md §3.4): 10 of 20 Panadol tablets. */
const firstReturn: ReturnReceiptData = {
  store: {
    name: 'Shifa Pharmacy',
    address: '12 Main Bazar, Lahore',
    phone: '0300-1234567',
    ntn: null,
    drugLicenseNo: '01-352-0001-23456P',
  },
  tillCode: 'T1',
  returnNo: 'T1-R000012',
  invoiceNo: 'T1-000123',
  at: '2026-10-21T11:40:00.000Z',
  cashier: 'Bilal',
  approvedBy: 'Sana',
  copy: 'original',
  reason: 'doctor_changed',
  note: null,
  lines: [
    {
      description: 'Panadol 500mg',
      qtyText: '1 Strip',
      refund: 24010,
      batches: [
        { batchNo: 'PN-01', expiryDate: '2027-01-31' },
        { batchNo: 'PN-02', expiryDate: '2027-06-30' },
      ],
    },
  ],
  refundNet: 24010,
  rounding: -10,
  refundTotal: 24000,
  taxByRate: [],
  refunds: [{ method: 'cash', provider: null, reference: null, amount: 24000 }],
  options: { showBatch: true, showSavings: true, footer: ['Thank you'] },
};

describe('return receipt', () => {
  it('lays out the worked return within 48 columns', () => {
    const doc = returnReceipt(firstReturn, { width: 48, timeZone: 'Asia/Karachi' });
    const text = renderText(doc).map((l) => l.trimEnd());
    expect(text.every((l) => l.length <= 48)).toBe(true);
    expect(text).toEqual([
      '          S h i f a   P h a r m a c y',
      '      12 Main Bazar, Lahore - 0300-1234567',
      '                 *** RETURN ***',
      '------------------------------------------------',
      'Return T1-R000012               21-10-2026 16:40',
      'For invoice T1-000123                    Till T1',
      'Cashier Bilal',
      'Approved by Sana',
      '------------------------------------------------',
      '1 Panadol 500mg',
      '  1 Strip                                 240.10',
      '  Batch PN-01 Exp Jan 2027',
      '  Batch PN-02 Exp Jun 2027',
      '------------------------------------------------',
      'Items back (1 item)                       240.10',
      'Rounding                                   -0.10',
      '================================================',
      'R E F U N D   R s   2 4 0 . 0 0',
      'Cash paid back                            240.00',
      'Reason: Doctor changed the medicine',
      '                   Thank you',
      '                  *T1-R000012*',
    ]);
  });

  it('prints what the preview shows, and opens the drawer for cash', () => {
    const doc = returnReceipt(firstReturn, { width: 48, timeZone: 'Asia/Karachi', drawerPin: 2 });
    const bytes = renderEscPos(doc);
    expect(Array.from(bytes.slice(2, 4))).toEqual([0x1b, 0x70]);
    expect(decodeEscPos(bytes, 48).map((l) => l.trimEnd())).toEqual(
      renderText(doc).map((l) => l.trimEnd()),
    );
  });

  it('shows card refunds, tax, the note and reprints, and fits 32 columns', () => {
    const doc = returnReceipt(
      {
        ...firstReturn,
        copy: 'reprint',
        approvedBy: null,
        reason: 'damaged',
        note: 'Seal broken',
        lines: [
          { description: 'Digital Thermometer', qtyText: '1 Piece', refund: 89999, batches: [] },
        ],
        refundNet: 89999,
        rounding: 1,
        refundTotal: 90000,
        taxByRate: [{ rateBp: 1800, tax: 13729 }],
        refunds: [{ method: 'card', provider: null, reference: '4417', amount: 90000 }],
        options: { showBatch: false, showSavings: true, footer: [] },
      },
      { width: 32, timeZone: 'Asia/Karachi' },
    );
    const text = renderText(doc).map((l) => l.trimEnd());
    expect(text.every((l) => l.length <= 32)).toBe(true);
    expect(text).toContain('*** REPRINT ***'.padStart(23));
    expect(text).toContain(`Card (ref 4417)${'900.00'.padStart(17)}`);
    expect(text).toContain('Sales tax 18% refunded: 137.29');
    expect(text).toContain('Reason: Damaged - Seal broken');
    expect(text.some((l) => l.startsWith('Approved by'))).toBe(false);
  });
});
