import type { SaleReceiptData } from '@app/db';
import { decodeEscPos, renderEscPos, renderText } from '@app/receipt';
import { describe, expect, it } from 'vitest';
import { saleReceipt } from './sale-receipt';

/** The worked sale from docs/m2-design.md. */
const worked: SaleReceiptData = {
  store: {
    name: 'Shifa Pharmacy',
    address: '12 Main Bazar, Lahore',
    phone: '0300-1234567',
    ntn: null,
    drugLicenseNo: '01-352-0001-23456P',
  },
  tillCode: 'T1',
  invoiceNo: 'T1-000123',
  at: '2026-10-21T09:05:00.000Z',
  cashier: 'Annus',
  copy: 'original',
  voided: false,
  lines: [
    {
      no: 1,
      description: 'Panadol 500mg',
      qtyText: '2 Strips',
      rate: { amount: 24500, unit: 'Strip' },
      gross: 49000,
      discount: 0,
      discountBp: null,
      batches: [
        { batchNo: 'PN-01', expiryDate: '2027-01-31' },
        { batchNo: 'PN-02', expiryDate: '2027-06-30' },
      ],
    },
    {
      no: 2,
      description: 'Brufen 400mg',
      qtyText: '3 Tablets',
      rate: { amount: 2457, unit: 'Tablet' },
      gross: 7370,
      discount: 0,
      discountBp: null,
      batches: [],
    },
    {
      no: 3,
      description: 'Augmentin 625mg',
      qtyText: '1 Strip, 2 Tablets',
      rate: { amount: 43620, unit: 'Strip' },
      gross: 58160,
      discount: 5816,
      discountBp: 1000,
      batches: [{ batchNo: 'AU1123', expiryDate: '2027-03-31' }],
    },
    {
      no: 4,
      description: 'Digital Thermometer',
      qtyText: '1 Piece',
      rate: { amount: 89999, unit: 'Piece' },
      gross: 89999,
      discount: 0,
      discountBp: null,
      batches: [{ batchNo: 'TH-1', expiryDate: null }],
    },
  ],
  itemsTotal: 204529,
  itemDiscounts: 5816,
  billDiscount: 2174,
  billDiscountBp: 200,
  rounding: -39,
  total: 196500,
  taxByRate: [{ rateBp: 1800, tax: 13729 }],
  payments: [
    { method: 'cash', provider: null, reference: null, amount: 96500, tendered: 100000 },
    { method: 'card', provider: null, reference: '4417', amount: 100000, tendered: null },
  ],
  change: 3500,
  saved: 7990,
  prescription: null,
  options: { showBatch: true, showSavings: true, footer: ['No returns on fridge items'] },
};

describe('sale receipt', () => {
  it('lays out the worked sale in 48 columns', () => {
    const doc = saleReceipt(worked, { width: 48, timeZone: 'Asia/Karachi' });
    const text = renderText(doc).map((l) => l.trimEnd());
    expect(text.every((l) => l.length <= 48)).toBe(true);
    expect(text).toEqual([
      '          S h i f a   P h a r m a c y',
      '      12 Main Bazar, Lahore - 0300-1234567',
      '        Drug licence 01-352-0001-23456P',
      '------------------------------------------------',
      'Invoice T1-000123               21-10-2026 14:05',
      'Cashier Annus                            Till T1',
      '------------------------------------------------',
      '1 Panadol 500mg',
      '  2 Strips @ 245.00/Strip                 490.00',
      '  Batch PN-01 Exp Jan 2027',
      '  Batch PN-02 Exp Jun 2027',
      '2 Brufen 400mg',
      '  3 Tablets @ 24.57/Tablet                 73.70',
      '3 Augmentin 625mg',
      '  1 Strip, 2 Tablets @ 436.20/Strip       581.60',
      '  Discount 10%                            -58.16',
      '  Batch AU1123 Exp Mar 2027',
      '4 Digital Thermometer',
      '  1 Piece @ 899.99/Piece                  899.99',
      '  Batch TH-1',
      '------------------------------------------------',
      'Items total (4 items)                   2,045.29',
      'Item discounts                            -58.16',
      'Bill discount 2%                          -21.74',
      'Rounding                                   -0.39',
      '================================================',
      'T O T A L   R s   1 , 9 6 5 . 0 0',
      'Cash received                           1,000.00',
      'Card (ref 4417)                         1,000.00',
      'Change                                     35.00',
      'Includes sales tax 18%: 137.29',
      'You saved Rs 79.90',
      '           No returns on fridge items',
      '                  *T1-000123*',
    ]);
  });

  it('prints what the preview shows, and opens the drawer first', () => {
    const doc = saleReceipt(worked, { width: 48, timeZone: 'Asia/Karachi', drawerPin: 2 });
    const bytes = renderEscPos(doc);
    expect(Array.from(bytes.slice(2, 4))).toEqual([0x1b, 0x70]);
    expect(decodeEscPos(bytes, 48).map((l) => l.trimEnd())).toEqual(
      renderText(doc).map((l) => l.trimEnd()),
    );
  });

  it('marks reprints and voids, and fits 32 columns', () => {
    const doc = saleReceipt(
      { ...worked, copy: 'reprint', voided: true },
      { width: 32, timeZone: 'Asia/Karachi' },
    );
    const text = renderText(doc);
    expect(text.every((l) => l.length <= 32)).toBe(true);
    expect(text.map((l) => l.trim())).toEqual(
      expect.arrayContaining(['*** REPRINT ***', '*** VOID ***']),
    );
  });
});
