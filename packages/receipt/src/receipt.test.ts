import { describe, expect, it } from 'vitest';
import {
  alignText,
  columnLines,
  pairLine,
  toPrintable,
  wrap,
  type ReceiptDocument,
} from './document';
import { ESCPOS, renderEscPos, renderText } from './render';

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
  openDrawer: true,
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

  it('cuts and opens the drawer at the end', () => {
    const tail = [...ESCPOS.feedAndCut, ...ESCPOS.openDrawer];
    expect(bytes.slice(-tail.length)).toEqual(tail);
  });

  it('can skip the cut and the drawer', () => {
    const plain = Array.from(renderEscPos({ ...doc, cut: false, openDrawer: false }));
    expect(plain.slice(-1)).toEqual([0x0a]);
  });
});
