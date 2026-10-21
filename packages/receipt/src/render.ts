import {
  alignText,
  columnLines,
  pairLine,
  toPrintable,
  wrap,
  type ReceiptDocument,
  type ReceiptLine,
} from './document';

/** Lines of a receipt as they will print, ignoring bold. Used for the on-screen preview. */
export function renderText(doc: ReceiptDocument): string[] {
  return doc.lines.flatMap((line) => lineText(line, doc.width));
}

function lineText(line: ReceiptLine, width: number): string[] {
  switch (line.kind) {
    case 'text': {
      // Large text is double width, so only half as many characters fit.
      const w = line.large ? Math.floor(width / 2) : width;
      const lines = wrap(toPrintable(line.text), w).map((l) =>
        alignText(l, w, line.align ?? 'left'),
      );
      return line.large
        ? lines.map((l) => l.split('').join(' ').padEnd(width).slice(0, width))
        : lines;
    }
    case 'pair':
      return pairLine(toPrintable(line.left), toPrintable(line.right), width);
    case 'columns':
      return columnLines(
        line.cells.map((c) => ({ ...c, text: toPrintable(c.text) })),
        width,
      );
    case 'rule':
      return [(line.char ?? '-').repeat(width)];
    case 'blank':
      return [''];
  }
}

// ESC/POS command bytes (Epson standard; supported by common 80mm printers).
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
export const ESCPOS = {
  init: [ESC, 0x40],
  codePage437: [ESC, 0x74, 0x00],
  alignLeft: [ESC, 0x61, 0x00],
  alignCenter: [ESC, 0x61, 0x01],
  alignRight: [ESC, 0x61, 0x02],
  boldOn: [ESC, 0x45, 0x01],
  boldOff: [ESC, 0x45, 0x00],
  sizeNormal: [GS, 0x21, 0x00],
  sizeDouble: [GS, 0x21, 0x11],
  /** Feed 4 lines then partial cut. */
  feedAndCut: [ESC, 0x64, 0x04, GS, 0x56, 0x42, 0x00],
  /** Pulse drawer pin 2: on 50 ms, off 500 ms. */
  openDrawer: [ESC, 0x70, 0x00, 0x19, 0xfa],
} as const;

function ascii(text: string): number[] {
  return Array.from(text, (ch) => ch.charCodeAt(0));
}

/**
 * ESC/POS bytes for a thermal printer. Text is laid out exactly as in `renderText`
 * (alignment is done with spaces), so the preview matches the paper; only bold and
 * large text use printer commands.
 */
export function renderEscPos(doc: ReceiptDocument): Uint8Array {
  const bytes: number[] = [...ESCPOS.init, ...ESCPOS.codePage437, ...ESCPOS.alignLeft];
  for (const line of doc.lines) {
    const bold =
      (line.kind === 'text' || line.kind === 'pair' || line.kind === 'columns') && line.bold;
    const large = line.kind === 'text' && line.large;
    if (bold) bytes.push(...ESCPOS.boldOn);
    if (large) bytes.push(...ESCPOS.sizeDouble);
    for (const text of large ? largeLines(line, doc.width) : lineText(line, doc.width)) {
      bytes.push(...ascii(text.trimEnd()), LF);
    }
    if (large) bytes.push(...ESCPOS.sizeNormal);
    if (bold) bytes.push(...ESCPOS.boldOff);
  }
  if (doc.cut ?? true) bytes.push(...ESCPOS.feedAndCut);
  if (doc.openDrawer) bytes.push(...ESCPOS.openDrawer);
  return Uint8Array.from(bytes);
}

/** Large text without the preview's letter spacing: the printer doubles the width itself. */
function largeLines(line: Extract<ReceiptLine, { kind: 'text' }>, width: number): string[] {
  const w = Math.floor(width / 2);
  return wrap(toPrintable(line.text), w).map((l) => alignText(l, w, line.align ?? 'left'));
}
