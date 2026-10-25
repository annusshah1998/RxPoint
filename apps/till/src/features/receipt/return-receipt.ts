import { formatExpiry, formatMoney, localDate, localTime } from '@app/core';
import type { ReturnReceiptData } from '@app/db';
import type { ReceiptDocument, ReceiptLine } from '@app/receipt';
import { S } from '../../strings';

const amount = (v: number) => formatMoney(v, { symbol: false });
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;

/** "21-10-2026 14:05" in the store's time zone. */
function when(at: string, timeZone: string): string {
  const [y, m, d] = localDate(new Date(at), timeZone).split('-');
  return `${d}-${m}-${y} ${localTime(new Date(at), timeZone)}`;
}

/** The return receipt, laid out for `width` characters (48 on 80 mm paper). */
export function returnReceipt(
  data: ReturnReceiptData,
  options: { width: number; timeZone: string; drawerPin?: 2 | 5 | null },
): ReceiptDocument {
  const lines: ReceiptLine[] = [];
  const push = (...l: ReceiptLine[]) => lines.push(...l);

  push({ kind: 'text', text: data.store.name, align: 'center', bold: true, large: true });
  const contact = [data.store.address, data.store.phone].filter(Boolean).join(' - ');
  if (contact) push({ kind: 'text', text: contact, align: 'center' });
  if (data.store.ntn) push({ kind: 'text', text: S.receipt.ntn(data.store.ntn), align: 'center' });
  push({ kind: 'text', text: S.receipt.returnTitle, align: 'center', bold: true });
  if (data.copy === 'reprint') push({ kind: 'text', text: S.receipt.reprint, align: 'center' });
  push(
    { kind: 'rule' },
    {
      kind: 'pair',
      left: S.receipt.returnNo(data.returnNo),
      right: when(data.at, options.timeZone),
    },
    {
      kind: 'pair',
      left: S.receipt.againstInvoice(data.invoiceNo),
      right: S.receipt.till(data.tillCode),
    },
    { kind: 'text', text: S.receipt.cashier(data.cashier) },
  );
  if (data.approvedBy) push({ kind: 'text', text: S.receipt.approvedBy(data.approvedBy) });
  push({ kind: 'rule' });

  data.lines.forEach((line, i) => {
    push(
      { kind: 'text', text: `${i + 1} ${line.description}` },
      { kind: 'pair', left: line.qtyText, right: amount(line.refund), indent: 2 },
    );
    if (data.options.showBatch) {
      for (const b of line.batches) {
        push({
          kind: 'text',
          text: S.receipt.batch(b.batchNo, b.expiryDate ? formatExpiry(b.expiryDate) : null),
          indent: 2,
        });
      }
    }
  });

  push(
    { kind: 'rule' },
    {
      kind: 'pair',
      left: S.receipt.itemsBack(data.lines.length),
      right: amount(data.refundNet),
    },
  );
  if (data.rounding !== 0) {
    push({ kind: 'pair', left: S.receipt.rounding, right: amount(data.rounding) });
  }
  push(
    { kind: 'rule', char: '=' },
    {
      kind: 'text',
      text: S.receipt.refundTotal(formatMoney(data.refundTotal)),
      bold: true,
      large: true,
    },
  );
  for (const r of data.refunds) {
    const left =
      r.method === 'cash'
        ? S.receipt.cashBack
        : r.method === 'card'
          ? S.receipt.card(r.reference)
          : S.receipt.wallet(S.receipt.wallets[r.provider ?? 'other'] ?? 'Wallet', r.reference);
    push({ kind: 'pair', left, right: amount(r.amount) });
  }
  for (const t of data.taxByRate) {
    push({ kind: 'text', text: S.receipt.taxBack(pct(t.rateBp), amount(t.tax)) });
  }
  const reason = S.returns.reasons[data.reason] ?? data.reason;
  push({
    kind: 'text',
    text: S.receipt.reason(data.note ? `${reason} - ${data.note}` : reason),
  });
  for (const f of data.options.footer) push({ kind: 'text', text: f, align: 'center' });
  push({ kind: 'barcode', data: data.returnNo });

  return {
    width: options.width,
    lines,
    cut: true,
    drawer: options.drawerPin ? { pin: options.drawerPin } : null,
  };
}
