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

function indented(lines: string[], indent: number): string[] {
  return indent > 0 ? lines.map((l) => ' '.repeat(indent) + l) : lines;
}

function lineText(line: ReceiptLine, width: number): string[] {
  switch (line.kind) {
    case 'text': {
      const indent = Math.min(line.indent ?? 0, width - 1);
      // Large text is double width, so only half as many characters fit.
      const w = line.large ? Math.floor(width / 2) : width - indent;
      const lines = wrap(toPrintable(line.text), w).map((l) =>
        alignText(l, w, line.align ?? 'left'),
      );
      return line.large
        ? lines.map((l) => l.split('').join(' ').padEnd(width).slice(0, width))
        : indented(lines, indent);
    }
    case 'pair': {
      const indent = Math.min(line.indent ?? 0, width - 1);
      return indented(
        pairLine(toPrintable(line.left), toPrintable(line.right), width - indent),
        indent,
      );
    }
    case 'columns':
      return columnLines(
        line.cells.map((c) => ({ ...c, text: toPrintable(c.text) })),
        width,
      );
    case 'rule':
      return [(line.char ?? '-').repeat(width)];
    case 'blank':
      return [''];
    case 'barcode':
      return [alignText(`*${toPrintable(line.data)}*`, width, 'center')];
    case 'feed':
      return Array.from({ length: Math.max(0, line.lines) }, () => '');
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
  drawerPin2: [ESC, 0x70, 0x00, 0x19, 0xfa],
  /** Pulse drawer pin 5. */
  drawerPin5: [ESC, 0x70, 0x01, 0x19, 0xfa],
  /** Barcode height 60 dots, module width 2, no printed text (the preview line has it). */
  barcodeSetup: [GS, 0x68, 60, GS, 0x77, 2, GS, 0x48, 0],
} as const;

function drawerPulse(pin: 2 | 5): readonly number[] {
  return pin === 5 ? ESCPOS.drawerPin5 : ESCPOS.drawerPin2;
}

/** Just opens the drawer (no receipt): reset, then the pulse. */
export function drawerKick(pin: 2 | 5): Uint8Array {
  return Uint8Array.from([...ESCPOS.init, ...drawerPulse(pin)]);
}

/** GS k m=73 (CODE128): length, then "{B" for code set B, then the data. */
function code128(data: string): number[] {
  const body = [0x7b, 0x42, ...ascii(toPrintable(data))];
  return [
    ...ESCPOS.alignCenter,
    ...ESCPOS.barcodeSetup,
    GS,
    0x6b,
    73,
    body.length,
    ...body,
    LF,
    ...ESCPOS.alignLeft,
  ];
}

function ascii(text: string): number[] {
  return Array.from(text, (ch) => ch.charCodeAt(0));
}

/**
 * ESC/POS bytes for a thermal printer. Text is laid out exactly as in `renderText`
 * (alignment is done with spaces), so the preview matches the paper; only bold and
 * large text use printer commands.
 */
export function renderEscPos(doc: ReceiptDocument): Uint8Array {
  const bytes: number[] = [...ESCPOS.init];
  // The drawer opens first, so the customer's change is ready while the receipt prints.
  if (doc.drawer) bytes.push(...drawerPulse(doc.drawer.pin));
  bytes.push(...ESCPOS.codePage437, ...ESCPOS.alignLeft);
  for (const line of doc.lines) {
    if (line.kind === 'barcode') {
      bytes.push(...code128(line.data));
      continue;
    }
    if (line.kind === 'feed') {
      if (line.lines > 0) bytes.push(ESC, 0x64, Math.min(line.lines, 255));
      continue;
    }
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
  return Uint8Array.from(bytes);
}

/**
 * The text a printer would print from ESC/POS bytes, with the commands taken out: large
 * text is letter-spaced and barcodes shown as *DATA*, as in the preview. For tests and the
 * fake printer, so what reaches the paper can be compared with what was shown on screen.
 */
export function decodeEscPos(bytes: Uint8Array, width: number): string[] {
  const out: string[] = [];
  let line = '';
  let large = false;
  let i = 0;
  const flush = () => {
    out.push(large ? line.split('').join(' ') : line);
    line = '';
  };
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b === ESC) {
      const cmd = bytes[i + 1];
      if (cmd === 0x40) i += 2;
      else if (cmd === 0x70) i += 5;
      else if (cmd === 0x64) {
        const n = bytes[i + 2] ?? 0;
        // The feed before the final cut is paper, not lines of the receipt.
        const atCut = bytes[i + 3] === GS && bytes[i + 4] === 0x56;
        if (!atCut) for (let k = 0; k < n; k++) out.push('');
        i += 3;
      } else i += 3; // ESC t / a / E n
      continue;
    }
    if (b === GS) {
      const cmd = bytes[i + 1];
      if (cmd === 0x21) {
        large = (bytes[i + 2] ?? 0) !== 0;
        i += 3;
      } else if (cmd === 0x56) i += 4;
      else if (cmd === 0x6b) {
        const n = bytes[i + 3] ?? 0;
        const data = String.fromCharCode(...bytes.slice(i + 6, i + 4 + n));
        out.push(alignText(`*${data}*`, width, 'center'));
        i += 4 + n;
        if (bytes[i] === LF) i += 1;
      } else i += 3; // GS h / w / H n
      continue;
    }
    if (b === LF) {
      flush();
      i += 1;
      continue;
    }
    line += String.fromCharCode(b);
    i += 1;
  }
  if (line) flush();
  return out;
}

/** Large text without the preview's letter spacing: the printer doubles the width itself. */
function largeLines(line: Extract<ReceiptLine, { kind: 'text' }>, width: number): string[] {
  const w = Math.floor(width / 2);
  return wrap(toPrintable(line.text), w).map((l) => alignText(l, w, line.align ?? 'left'));
}
