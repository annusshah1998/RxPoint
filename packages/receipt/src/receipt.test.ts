import { describe, expect, it } from 'vitest';
import {
  alignText,
  columnLines,
  pairLine,
  toPrintable,
  wrap,
  type ReceiptDocument,
} from './document';
import { ESCPOS, decodeEscPos, drawerKick, renderEscPos, renderText } from './render';

describe('layout helpers', () => {
  it('wraps at spaces and hard-breaks long words', () => {
    expect(wrap('Augmentin 625mg Tablet', 10)).toEqual(['Augmentin', '625mg', 'Tablet']);
    expect(wrap('ABCDEFGHIJKL', 5)).toEqual(['ABCDE', 'FGHIJ', 'KL']);
    expect(wrap('a\n\nb', 5)).toEqual(['a', '', 'b']);
  });

  it('aligns within a width', () => {
    expect(alignText('ab', 6, 'right')).toBe('    ab');
    expect(alignText('ab', 6, 'center')).toBe('  ab  ');
    expect(alignText('abcdefgh', 4, 'left')).toBe('abcd');
  });

  it('keeps amounts on the right of pair lines', () => {
    expect(pairLine('Total', 'Rs 1,250.00', 20)).toEqual(['Total    Rs 1,250.00']);
    expect(pairLine('Panadol Extra Tablets', '45.00', 16)).toEqual([
      'Panadol Extra   ',
      'Tablets    45.00',
    ]);
    // Last line too long to share with the amount: the amount gets its own line.
    expect(pairLine('Panadol Extra', '1,045.00', 16)).toEqual([
      'Panadol Extra   ',
      '        1,045.00',
    ]);
  });

  it('lays out columns and wraps inside them', () => {
    expect(
      columnLines(
        [
          { text: 'Augmentin 625mg', width: 10 },
          { text: '2', width: 4, align: 'right' },
          { text: '872.40', width: 0, align: 'right' },
        ],
        24,
      ),
    ).toEqual(['Augmentin    2    872.40', '625mg                   ']);
  });

  it('reduces text to printable ASCII', () => {
    expect(toPrintable('Café – “Rx” · 2×')).toBe('Cafe - "Rx" - 2x');
    expect(toPrintable('دوا')).toBe('???');
  });
});

const doc: ReceiptDocument = {
  width: 32,
  lines: [
    { kind: 'text', text: 'Shifa Pharmacy', align: 'center', bold: true },
    { kind: 'rule' },
    { kind: 'pair', left: 'Panadol 500mg x2', right: '52.00' },
    { kind: 'rule', char: '=' },
    { kind: 'text', text: 'TOTAL 52', align: 'center', large: true },
    { kind: 'blank' },
  ],
  drawer: { pin: 2 },
};

describe('renderText', () => {
  it('renders the preview line by line', () => {
    expect(renderText(doc)).toEqual([
      '         Shifa Pharmacy         ',
      '--------------------------------',
      'Panadol 500mg x2           52.00',
      '================================',
      // Double width: every character, spaces included, takes two columns.
      '        T O T A L   5 2         ',
      '',
    ]);
  });
});

describe('renderEscPos', () => {
  const bytes = Array.from(renderEscPos(doc));
  const text = String.fromCharCode(...bytes);

  it('starts by resetting the printer', () => {
    expect(bytes.slice(0, 2)).toEqual([...ESCPOS.init]);
  });

  it('prints the same lines as the preview', () => {
    expect(text).toContain('         Shifa Pharmacy\n');
    expect(text).toContain('Panadol 500mg x2           52.00\n');
  });

  it('wraps bold and large text in printer commands', () => {
    const boldOn = String.fromCharCode(...ESCPOS.boldOn);
    const large = String.fromCharCode(...ESCPOS.sizeDouble);
    expect(text).toContain(`${boldOn}         Shifa Pharmacy`);
    expect(text).toContain(`${large}    TOTAL 52\n`);
  });

  it('opens the drawer first, while the receipt prints, and cuts at the end', () => {
    expect(bytes.slice(2, 7)).toEqual([...ESCPOS.drawerPin2]);
    expect(bytes.slice(-ESCPOS.feedAndCut.length)).toEqual([...ESCPOS.feedAndCut]);
    const pin5 = Array.from(renderEscPos({ ...doc, drawer: { pin: 5 } }));
    expect(pin5.slice(2, 7)).toEqual([...ESCPOS.drawerPin5]);
  });

  it('can skip the cut and the drawer', () => {
    const plain = Array.from(renderEscPos({ ...doc, cut: false, drawer: null }));
    expect(plain.slice(-1)).toEqual([0x0a]);
    expect(plain.slice(2, 4)).toEqual([...ESCPOS.codePage437].slice(0, 2));
  });

  it('opens just the drawer', () => {
    expect(Array.from(drawerKick(5))).toEqual([...ESCPOS.init, ...ESCPOS.drawerPin5]);
  });
});

describe('indents, barcodes and feeds', () => {
  const sale: ReceiptDocument = {
    width: 32,
    lines: [
      { kind: 'text', text: '1 Augmentin 625mg Tablet' },
      { kind: 'pair', left: '1 Strip, 2 Tablets @ 436.20/Strip', right: '581.60', indent: 2 },
      { kind: 'text', text: 'Batch AU1123 Exp Mar 2027', indent: 2 },
      { kind: 'feed', lines: 1 },
      { kind: 'text', text: 'TOTAL 1965', align: 'center', large: true },
      { kind: 'barcode', data: 'T1-000123' },
    ],
  };

  it('keeps indents when wrapping', () => {
    expect(renderText(sale).every((l) => l.length <= 32)).toBe(true);
    expect(renderText(sale)).toEqual([
      '1 Augmentin 625mg Tablet        ',
      '  1 Strip, 2 Tablets @          ',
      '  436.20/Strip            581.60',
      '  Batch AU1123 Exp Mar 2027     ',
      '',
      '      T O T A L   1 9 6 5       ',
      '          *T1-000123*           ',
    ]);
  });

  it('prints the barcode as CODE128 and decodes back to the preview', () => {
    const bytes = renderEscPos(sale);
    const text = String.fromCharCode(...bytes);
    expect(text).toContain(String.fromCharCode(0x1d, 0x6b, 73, 11, 0x7b, 0x42) + 'T1-000123');
    expect(decodeEscPos(bytes, 32).map((l) => l.trimEnd())).toEqual(
      renderText(sale).map((l) => l.trimEnd()),
    );
  });
});
