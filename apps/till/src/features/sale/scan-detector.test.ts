import { describe, expect, it } from 'vitest';
import {
  createScanDetector,
  type ScanDetector,
  type ScanKey,
  type ScanStep,
} from './scan-detector';

/** Types `text` then Enter, one key every `gap` ms from `start`. Returns every step. */
function type(d: ScanDetector, text: string, gap: number, start = 1000): ScanStep[] {
  const steps = [...text].map((key, i) => d.key({ key, timeStamp: start + i * gap }));
  steps.push(d.key({ key: 'Enter', timeStamp: start + text.length * gap }));
  return steps;
}

const lastScan = (steps: ScanStep[]) => steps.at(-1)!.scan;

describe('createScanDetector', () => {
  it('reports a barcode typed a few ms per key and ended with Enter', () => {
    const d = createScanDetector({ minLength: 6, maxGapMs: 35 });
    const steps = type(d, '8961234567890', 5);
    expect(lastScan(steps)).toBe('8961234567890');
    expect(steps.slice(0, -1).every((s) => s.scan === null)).toBe(true);
  });

  it('ignores the same code typed by a person', () => {
    const d = createScanDetector();
    expect(lastScan(type(d, '8961234567890', 120))).toBeNull();
  });

  it('needs at least minLength characters', () => {
    const d = createScanDetector({ minLength: 6, maxGapMs: 35 });
    expect(lastScan(type(d, '12345', 5))).toBeNull();
    expect(lastScan(type(d, '123456', 5, 5000))).toBe('123456');
  });

  it('allows gaps up to maxGapMs, Enter included, and no longer', () => {
    const d = createScanDetector({ minLength: 6, maxGapMs: 35 });
    expect(lastScan(type(d, '123456', 35))).toBe('123456');
    expect(lastScan(type(d, '123456', 36, 5000))).toBeNull();

    // Fast characters but a slow Enter: a person pressing Enter after a burst.
    for (const [i, key] of [...'123456'].entries()) d.key({ key, timeStamp: 9000 + i * 5 });
    expect(d.key({ key: 'Enter', timeStamp: 9025 + 200 }).scan).toBeNull();
  });

  it('starts a new run after a slow gap, and says so', () => {
    const d = createScanDetector();
    // "12" typed by hand, then a scan into the same field.
    expect(d.key({ key: '1', timeStamp: 0 }).runStart).toBe(true);
    expect(d.key({ key: '2', timeStamp: 300 }).runStart).toBe(true);
    const steps = type(d, '8961234567890', 4, 900);
    expect(steps[0]!.runStart).toBe(true);
    expect(steps.slice(1).some((s) => s.runStart)).toBe(false);
    expect(lastScan(steps)).toBe('8961234567890');
  });

  it('keeps Shift inside a run (capital letters) but not other keys', () => {
    const d = createScanDetector();
    const keys: ScanKey[] = [];
    let t = 0;
    for (const ch of 'AB12CD') {
      if (ch >= 'A' && ch <= 'Z') keys.push({ key: 'Shift', timeStamp: (t += 2) });
      keys.push({ key: ch, timeStamp: (t += 3) });
    }
    keys.push({ key: 'Enter', timeStamp: t + 3 });
    expect(keys.map((k) => d.key(k)).at(-1)!.scan).toBe('AB12CD');

    for (const breaker of ['Backspace', 'ArrowLeft', 'Tab', 'F9']) {
      const e = createScanDetector();
      for (const [i, key] of [...'123'].entries()) e.key({ key, timeStamp: i * 5 });
      e.key({ key: breaker, timeStamp: 15 });
      expect(lastScan(type(e, '456', 5, 20)), breaker).toBeNull();
    }
  });

  it('never counts shortcuts or a held-down key', () => {
    const ctrl = createScanDetector();
    const steps = [...'123456'].map((key, i) =>
      ctrl.key({ key, timeStamp: i * 5, ctrlKey: i === 2 }),
    );
    steps.push(ctrl.key({ key: 'Enter', timeStamp: 30 }));
    expect(lastScan(steps)).toBeNull();

    // Alt+K, Alt+W, Alt+M… pressed straight before typing a code don't join it.
    const alt = createScanDetector();
    const altSteps = [...'k123456'].map((key, i) =>
      alt.key({ key, timeStamp: i * 5, altKey: i === 0 }),
    );
    altSteps.push(alt.key({ key: 'Enter', timeStamp: 35 }));
    expect(lastScan(altSteps)).toBe('123456');
    const altInside = createScanDetector();
    const insideSteps = [...'123456'].map((key, i) =>
      altInside.key({ key, timeStamp: i * 5, altKey: i === 3 }),
    );
    insideSteps.push(altInside.key({ key: 'Enter', timeStamp: 30 }));
    expect(lastScan(insideSteps)).toBeNull();

    const held = createScanDetector();
    const repeats = [...'000000'].map((key, i) =>
      held.key({ key, timeStamp: i * 30, repeat: i > 0 }),
    );
    repeats.push(held.key({ key: 'Enter', timeStamp: 180 }));
    expect(lastScan(repeats)).toBeNull();
  });

  it('is ready for the next scan straight after one, and after reset()', () => {
    const d = createScanDetector();
    expect(lastScan(type(d, '8961234567890', 5, 0))).toBe('8961234567890');
    expect(lastScan(type(d, '8964000000017', 5, 100))).toBe('8964000000017');

    for (const [i, key] of [...'896123'].entries()) d.key({ key, timeStamp: 500 + i * 5 });
    d.reset();
    expect(d.key({ key: 'Enter', timeStamp: 530 }).scan).toBeNull();
  });

  it('copes with timestamps that go backwards', () => {
    const d = createScanDetector();
    const steps = [...'123456'].map((key, i) => d.key({ key, timeStamp: 100 - i }));
    steps.push(d.key({ key: 'Enter', timeStamp: 90 }));
    expect(lastScan(steps)).toBe('123456');
  });
});
