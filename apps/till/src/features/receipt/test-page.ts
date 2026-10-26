import type { ReceiptDocument, ReceiptLine } from '@app/receipt';
import type { PrinterSettings } from '../../platform/printer';
import { S } from '../../strings';

/** "----+----1----+----2…" ending in "|", exactly `width` characters. */
export function ruler(width: number): string {
  const marks = Array.from({ length: width }, (_, i) => {
    const col = i + 1;
    if (col % 10 === 0) return String((col / 10) % 10);
    return col % 5 === 0 ? '+' : '-';
  });
  marks[width - 1] = '|';
  return marks.join('');
}

/**
 * A page to check a new printer (§6.1): the ruler shows whether the characters-per-line
 * setting fits the paper, then bold, large text, a barcode and the cut.
 */
export function testPage(settings: PrinterSettings, storeName: string): ReceiptDocument {
  const width = settings.printer.columns;
  const p = settings.printer;
  const where =
    p.mode === 'network'
      ? S.testPage.network(p.host, p.port)
      : (p.printerName ?? S.testPage.windowsDefault);
  const lines: ReceiptLine[] = [
    { kind: 'text', text: S.testPage.title, align: 'center', bold: true, large: true },
    { kind: 'text', text: storeName, align: 'center' },
    { kind: 'text', text: S.testPage.printer(where), align: 'center' },
    { kind: 'rule' },
    { kind: 'text', text: S.testPage.ruler(width) },
    { kind: 'text', text: ruler(width) },
    { kind: 'text', text: '1234567890'.repeat(Math.ceil(width / 10)).slice(0, width) },
    { kind: 'text', text: S.testPage.rulerFits },
    { kind: 'rule' },
    { kind: 'text', text: S.testPage.bold, bold: true },
    { kind: 'text', text: S.testPage.large, large: true },
    { kind: 'blank' },
    { kind: 'text', text: S.testPage.barcode },
    { kind: 'barcode', data: 'TEST123' },
    { kind: 'rule', char: '=' },
    { kind: 'text', text: S.testPage.cut(p.cut) },
    { kind: 'text', text: S.testPage.end, align: 'center' },
  ];
  return { width, lines, cut: p.cut, drawer: null };
}
