/**
 * Tells a barcode scanner from a person typing. A USB scanner is a keyboard that types the
 * whole code a few milliseconds per key and then presses Enter; people leave much longer
 * gaps. The thresholds are guesses until a real scanner is timed (docs/m2-design.md §3.14).
 */

export interface ScanDetectorOptions {
  /** Fewest characters before Enter that count as a scan. */
  minLength: number;
  /** Longest gap between two keys of one scan, Enter included, in ms. */
  maxGapMs: number;
}

export const SCAN_DETECTOR_OPTIONS: ScanDetectorOptions = { minLength: 6, maxGapMs: 35 };

/** The parts of a keydown event the detector reads. */
export interface ScanKey {
  key: string;
  timeStamp: number;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export interface ScanStep {
  /** The code, when this key is the Enter that ends a fast run of characters. */
  scan: string | null;
  /**
   * This key starts a new run of characters. What the field held just before it is what
   * to put back if the run turns out to be a scan.
   */
  runStart: boolean;
}

export interface ScanDetector {
  /** Feed every keydown, in order. */
  key(e: ScanKey): ScanStep;
  reset(): void;
}

// Scanners press Shift for capital letters; it doesn't break a run.
const PASS_THROUGH = new Set(['Shift', 'CapsLock']);

export function createScanDetector(
  options: ScanDetectorOptions = SCAN_DETECTOR_OPTIONS,
): ScanDetector {
  let run = '';
  let last = -Infinity;
  const reset = () => {
    run = '';
    last = -Infinity;
  };

  return {
    key(e) {
      if (PASS_THROUGH.has(e.key)) return { scan: null, runStart: false };
      const fast = e.timeStamp - last <= options.maxGapMs;
      if (e.key === 'Enter') {
        const scan = fast && run.length >= options.minLength ? run : null;
        reset();
        return { scan, runStart: false };
      }
      // A held-down key repeats about every 30 ms; a scanner never sends repeats or shortcuts.
      const typed = e.key.length === 1 && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey;
      if (!typed) {
        reset();
        return { scan: null, runStart: false };
      }
      const runStart = run === '' || !fast;
      run = runStart ? e.key : run + e.key;
      last = e.timeStamp;
      return { scan: null, runStart };
    },
    reset,
  };
}
