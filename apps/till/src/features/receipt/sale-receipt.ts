import { formatExpiry, formatMoney, localDate, localTime } from '@app/core';
import type { SaleReceiptData } from '@app/db';
import type { ReceiptDocument, ReceiptLine } from '@app/receipt';
import { S } from '../../strings';

const amount = (v: number) => formatMoney(v, { symbol: false });
const pct = (bp: number | null) =>
  bp === null ? null : `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;

/** "21-10-2026 14:05" in the store's time zone. */
function when(at: string, timeZone: string): string {
  const [y, m, d] = localDate(new Date(at), timeZone).split('-');
  return `${d}-${m}-${y} ${localTime(new Date(at), timeZone)}`;
}

/** The sale receipt, laid out for `width` characters (48 on 80 mm paper). */
export function saleReceipt(
  data: SaleReceiptData,
  options: { width: number; timeZone: string; drawerPin?: 2 | 5 | null },
): ReceiptDocument {
  const lines: ReceiptLine[] = [];
  const push = (...l: ReceiptLine[]) => lines.push(...l);

  push({ kind: 'text', text: data.store.name, align: 'center', bold: true, large: true });
  const contact = [data.store.address, data.store.phone].filter(Boolean).join(' - ');
  if (contact) push({ kind: 'text', text: contact, align: 'center' });
  if (data.store.drugLicenseNo) {
    push({ kind: 'text', text: S.receipt.drugLicence(data.store.drugLicenseNo), align: 'center' });
  }
  if (data.store.ntn) push({ kind: 'text', text: S.receipt.ntn(data.store.ntn), align: 'center' });
  if (data.copy === 'reprint') push({ kind: 'text', text: S.receipt.reprint, align: 'center' });
  if (data.voided) push({ kind: 'text', text: S.receipt.voided, align: 'center', bold: true });
  push(
    { kind: 'rule' },
    {
      kind: 'pair',
      left: S.receipt.invoice(data.invoiceNo),
      right: when(data.at, options.timeZone),
    },
    { kind: 'pair', left: S.receipt.cashier(data.cashier), right: S.receipt.till(data.tillCode) },
    { kind: 'rule' },
  );

  for (const line of data.lines) {
    push(
      { kind: 'text', text: `${line.no} ${line.description}` },
      {
        kind: 'pair',
        left: S.receipt.rate(line.qtyText, amount(line.rate.amount), line.rate.unit),
        right: amount(line.gross),
        indent: 2,
      },
    );
    if (line.discount > 0) {
      push({
        kind: 'pair',
        left: S.receipt.discount(pct(line.discountBp)),
        right: amount(-line.discount),
        indent: 2,
      });
    }
    if (data.options.showBatch) {
      for (const b of line.batches) {
        push({
          kind: 'text',
          text: S.receipt.batch(b.batchNo, b.expiryDate ? formatExpiry(b.expiryDate) : null),
          indent: 2,
        });
      }
    }
  }

  push(
    { kind: 'rule' },
    { kind: 'pair', left: S.receipt.itemsTotal(data.lines.length), right: amount(data.itemsTotal) },
  );
  if (data.itemDiscounts > 0) {
    push({ kind: 'pair', left: S.receipt.itemDiscounts, right: amount(-data.itemDiscounts) });
  }
  if (data.billDiscount > 0) {
    push({
      kind: 'pair',
      left: S.receipt.billDiscount(pct(data.billDiscountBp)),
      right: amount(-data.billDiscount),
    });
  }
  if (data.rounding !== 0) {
    push({ kind: 'pair', left: S.receipt.rounding, right: amount(data.rounding) });
  }
  push(
    { kind: 'rule', char: '=' },
    { kind: 'text', text: S.receipt.total(formatMoney(data.total)), bold: true, large: true },
  );
  for (const p of data.payments) {
    const left =
      p.method === 'cash'
        ? S.receipt.cash
        : p.method === 'card'
          ? S.receipt.card(p.reference)
          : S.receipt.wallet(S.receipt.wallets[p.provider ?? 'other'] ?? 'Wallet', p.reference);
    push({
      kind: 'pair',
      left,
      right: amount(p.method === 'cash' ? (p.tendered ?? p.amount) : p.amount),
    });
  }
  if (data.change > 0) push({ kind: 'pair', left: S.receipt.change, right: amount(data.change) });
  for (const t of data.taxByRate) {
    push({ kind: 'text', text: S.receipt.tax(pct(t.rateBp)!, amount(t.tax)) });
  }
  if (data.options.showSavings && data.saved > 0) {
    push({ kind: 'text', text: S.receipt.saved(formatMoney(data.saved)) });
  }
  if (data.prescription) {
    push({
      kind: 'text',
      text: S.receipt.patient(data.prescription.patientName, data.prescription.prescriberName),
    });
  }
  for (const f of data.options.footer) push({ kind: 'text', text: f, align: 'center' });
  push({ kind: 'barcode', data: data.invoiceNo });

  return {
    width: options.width,
    lines,
    cut: true,
    drawer: options.drawerPin ? { pin: options.drawerPin } : null,
  };
}
