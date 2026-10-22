/**
 * A receipt as a list of lines, independent of the printer. The same document is
 * rendered as plain text for the on-screen preview and as ESC/POS bytes for a
 * thermal printer, so what staff see is what prints.
 */
export type Align = 'left' | 'center' | 'right';

export type ReceiptLine =
  /**
   * Free text, wrapped to the paper width. `large` prints double width and height.
   * `indent` starts every wrapped line that many characters in.
   */
  | {
      kind: 'text';
      text: string;
      align?: Align;
      bold?: boolean;
      large?: boolean;
      indent?: number;
    }
  /** Left text and right text on one line, e.g. "Total" … "Rs 1,250.00". */
  | { kind: 'pair'; left: string; right: string; bold?: boolean; indent?: number }
  /** A row of fixed-width columns. Widths are characters; the last column fills the rest. */
  | { kind: 'columns'; cells: { text: string; width: number; align?: Align }[]; bold?: boolean }
  | { kind: 'rule'; char?: '-' | '=' }
  | { kind: 'blank' }
  /** A CODE128 barcode (e.g. the invoice number, scanned at returns). */
  | { kind: 'barcode'; data: string }
  /** Extra paper, e.g. before the cut. */
  | { kind: 'feed'; lines: number };

export interface ReceiptDocument {
  /** Characters per line: 48 for 80mm paper (font A), 32 for 58mm. */
  width: number;
  lines: ReceiptLine[];
  /** Cut the paper at the end (printers without a cutter ignore it). */
  cut?: boolean;
  /**
   * Open the cash drawer wired to the printer (on pin 2 or 5), first thing, so it opens
   * while the receipt prints.
   */
  drawer?: { pin: 2 | 5 } | null;
}

/** Characters per line: 80 mm paper in font A (48) or a narrower font setting (42), 58 mm (32). */
export const PAPER_WIDTH = { mm80: 48, mm80small: 42, mm58: 32 } as const;

/**
 * Thermal printers here print a basic code page, so text is reduced to printable ASCII.
 * Common typographic characters are mapped; anything else becomes "?".
 * (Urdu will need printing as an image; see docs/plan.md.)
 */
export function toPrintable(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/[\u00b7\u2022]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00d7/g, 'x')
    .replace(/[\t\u00a0]/g, ' ')
    .replace(/[^\x20-\x7e\n]/g, '?');
}

/** Splits text into lines of at most `width` characters, breaking at spaces when it can. */
export function wrap(text: string, width: number): string[] {
  if (width < 1) throw new RangeError('width must be at least 1');
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ').filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (let word of words) {
      while (word.length > width) {
        // A word longer than the line: fill what's left, then hard-break.
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export function alignText(text: string, width: number, align: Align): string {
  const t = text.length > width ? text.slice(0, width) : text;
  const gap = width - t.length;
  if (align === 'right') return ' '.repeat(gap) + t;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + t + ' '.repeat(gap - left);
  }
  return t + ' '.repeat(gap);
}

/** "Total ........ Rs 10.00" style line; the right side wins if both don't fit. */
export function pairLine(left: string, right: string, width: number): string[] {
  if (right.length >= width) return [...wrap(left, width), alignText(right, width, 'right')];
  const room = width - right.length - 1;
  // Earlier lines use the full width; only the last one shares its line with the amount.
  const leftLines = wrap(left, width);
  const last = leftLines.pop() ?? '';
  const full = leftLines.map((l) => alignText(l, width, 'left'));
  if (last.length > room) {
    return [...full, alignText(last, width, 'left'), alignText(right, width, 'right')];
  }
  return [...full, alignText(last, room, 'left') + ' ' + right];
}

/** A row of columns; text that doesn't fit a column wraps onto extra rows. */
export function columnLines(
  cells: { text: string; width: number; align?: Align }[],
  width: number,
): string[] {
  const fixed = cells.slice(0, -1).reduce((sum, c) => sum + c.width, 0);
  const widths = cells.map((c, i) =>
    i === cells.length - 1 ? Math.max(1, width - fixed) : c.width,
  );
  const wrapped = cells.map((c, i) => wrap(c.text, widths[i]!));
  const rows = Math.max(...wrapped.map((w) => w.length));
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    out.push(
      cells.map((c, i) => alignText(wrapped[i]![r] ?? '', widths[i]!, c.align ?? 'left')).join(''),
    );
  }
  return out.map((line) => line.slice(0, width));
}
