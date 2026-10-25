import { useEffect, useRef } from 'react';
import { createScanDetector } from './scan-detector';

type TextField = HTMLInputElement | HTMLTextAreaElement;

export interface ScanContext {
  /** Where the burst was typed: a field, a button, or the page. */
  target: EventTarget | null;
  /** What that field held before the burst, or null when it isn't a text field. */
  before: string | null;
}

/**
 * Catches a scanner burst wherever the cursor is, while `enabled`. When a burst ends in Enter
 * and `onScan` takes it (returns true), that Enter does nothing else (no submit, no button
 * press) and the field the burst went into gets back what it held before.
 */
export function useScanGuard(
  onScan: (code: string, context: ScanContext) => boolean,
  enabled = true,
) {
  const handler = useRef(onScan);
  useEffect(() => {
    handler.current = onScan;
  });

  useEffect(() => {
    if (!enabled) return;
    const detector = createScanDetector();
    let snapshot: { field: TextField; value: string } | null = null;
    const onKey = (e: KeyboardEvent) => {
      const step = detector.key(e);
      if (step.runStart)
        snapshot = isTextField(e.target) ? { field: e.target, value: e.target.value } : null;
      if (!step.scan) return;
      const before = snapshot?.field === e.target ? snapshot.value : null;
      snapshot = null;
      if (!handler.current(step.scan, { target: e.target, before })) return;
      e.preventDefault();
      e.stopPropagation();
      if (before !== null) putBack(e.target as TextField, before);
    };
    // Capture phase, so this runs before the field's own Enter handling.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}

function isTextField(target: EventTarget | null): target is TextField {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
}

/**
 * Sets a React-controlled field's value as if typed, so its onChange sees it. Setting
 * `.value` directly would be overwritten on the next render.
 */
function putBack(field: TextField, value: string) {
  if (field.value === value) return;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
