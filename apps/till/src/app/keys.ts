import { useEffect } from 'react';

/** The parts of a keydown event the key rules read. */
export interface KeyPress {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * The letter of a shortcut key, in lower case. Uses the typed letter, so Ctrl+C stays copy
 * on any Latin layout, and falls back to the key's place (KeyM) when the layout types
 * something else, such as Urdu.
 */
export function keyLetter(e: Pick<KeyPress, 'key' | 'code'>): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  return /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase() ?? null;
}

/** The digit of a top-row number key (not the number pad, where Alt types Alt codes). */
export function keyDigit(e: Pick<KeyPress, 'key' | 'code'>): string | null {
  const fromCode = /^Digit(\d)$/.exec(e.code)?.[1];
  if (fromCode) return fromCode;
  return /^\d$/.test(e.key) && !e.code.startsWith('Numpad') ? e.key : null;
}

/** True when only these modifiers are held (Shift, Ctrl, Alt, Meta). */
export function onlyMods(e: KeyPress, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean }) {
  return (
    e.ctrlKey === !!mods.ctrl &&
    e.altKey === !!mods.alt &&
    e.shiftKey === !!mods.shift &&
    !e.metaKey
  );
}

// Find, find next, history, downloads, print, reload, save, view source, bookmark, search.
const CTRL_LETTERS = new Set(['f', 'g', 'h', 'j', 'p', 'r', 's', 'u', 'd', 'k']);
// Zoom in, out and back to 100%, on the main keys or the number pad.
const ZOOM_CODES = new Set(['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract', 'Numpad0']);
const ZOOM_KEYS = new Set(['+', '=', '-', '_', '0']);

/**
 * Keys the browser would act on: F1–F12, Ctrl+F/G/H/J/P/R/S/U/D/K, Ctrl+plus/minus/0,
 * Alt+←/→ and Ctrl+Shift+Delete (docs/m2-design.md §5.4). The till cancels what the browser
 * does with them, so a stray press never reloads, prints, finds or zooms; its own shortcuts
 * on these keys still run. Typing and editing keys (Ctrl+A/C/V/X/Z) are left alone.
 */
export function isBrowserKey(e: KeyPress): boolean {
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return true;
  if (e.ctrlKey && !e.altKey) {
    const letter = keyLetter(e);
    if (letter && CTRL_LETTERS.has(letter)) return true;
    if (ZOOM_CODES.has(e.code) || ZOOM_KEYS.has(e.key)) return true;
    // The browser's "Clear browsing data"; on the Sale screen it clears the sale.
    if (e.shiftKey && e.key === 'Delete') return true;
  }
  // Back and forward.
  return e.altKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
}

/**
 * Cancels the browser's own action for `isBrowserKey` keys, on every screen (login
 * included). Runs in the capture phase and doesn't stop the event, so the till's handlers
 * still see the key.
 */
export function useBrowserKeyGuard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isBrowserKey(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);
}

/** Whether a dialog is open: screen shortcuts wait until it is closed. */
export function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"]') !== null;
}
