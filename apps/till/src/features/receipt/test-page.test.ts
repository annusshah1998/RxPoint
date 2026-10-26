import { DEFAULT_DEVICE_SETTINGS } from '@app/db';
import { decodeEscPos, renderEscPos, renderText } from '@app/receipt';
import { describe, expect, it } from 'vitest';
import { ruler, testPage } from './test-page';

const settings = (columns: 48 | 42 | 32, cut = true) => ({
  printer: {
    ...DEFAULT_DEVICE_SETTINGS.printer,
    mode: 'network' as const,
    host: '192.168.1.50',
    columns,
    cut,
  },
  drawer: DEFAULT_DEVICE_SETTINGS.drawer,
});

describe('testPage', () => {
  it('has a ruler exactly as wide as the line', () => {
    expect(ruler(48)).toBe('----+----1----+----2----+----3----+----4----+--|');
    expect(ruler(42)).toHaveLength(42);
    expect(ruler(32)).toHaveLength(32);
  });

  it.each([48, 42, 32] as const)('fits %i columns, with the ruler on one line', (columns) => {
    const doc = testPage(settings(columns), 'Shifa Pharmacy');
    const lines = renderText(doc);
    expect(lines.every((l) => l.length <= columns)).toBe(true);
    expect(lines).toContain(ruler(columns));
    expect(lines.join('\n')).toContain('192.168.1.50:9100');
  });

  it('prints bold, large text, a barcode and the cut, never the drawer', () => {
    const doc = testPage(settings(48), 'Shifa Pharmacy');
    expect(doc.drawer).toBeNull();
    const bytes = Array.from(renderEscPos(doc));
    const has = (seq: number[]) => bytes.some((_, i) => seq.every((b, k) => bytes[i + k] === b));
    expect(has([0x1b, 0x45, 0x01])).toBe(true); // bold
    expect(has([0x1d, 0x21, 0x11])).toBe(true); // large
    expect(has([0x1d, 0x6b, 0x49])).toBe(true); // CODE128
    expect(has([0x1d, 0x56])).toBe(true); // cut
    expect(has([0x1b, 0x70])).toBe(false); // no drawer
    expect(decodeEscPos(renderEscPos(doc), 48)).toContain(
      '                   *TEST123*                    ',
    );
  });

  it('leaves the cut out when cutting is off', () => {
    const doc = testPage(settings(48, false), 'Shifa Pharmacy');
    expect(doc.cut).toBe(false);
    expect(renderText(doc).join('\n')).toContain('Cutting is off.');
  });
});
