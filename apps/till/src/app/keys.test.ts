import { describe, expect, it } from 'vitest';
import { isBrowserKey, keyDigit, keyLetter, type KeyPress } from './keys';

function press(key: string, code: string, mods: Partial<KeyPress> = {}): KeyPress {
  return { key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}
const ctrl = { ctrlKey: true };

describe('isBrowserKey', () => {
  it('takes every function key, with or without Shift', () => {
    for (let n = 1; n <= 12; n++) expect(isBrowserKey(press(`F${n}`, `F${n}`))).toBe(true);
    expect(isBrowserKey(press('F5', 'F5', { shiftKey: true }))).toBe(true);
    expect(isBrowserKey(press('F5', 'F5', ctrl))).toBe(true);
  });

  it('takes the Ctrl letters the browser uses for find, print, reload and the like', () => {
    for (const l of 'fghjprsudk') {
      expect(isBrowserKey(press(l, `Key${l.toUpperCase()}`, ctrl))).toBe(true);
    }
    // Ctrl+Shift+R is a hard reload.
    expect(isBrowserKey(press('R', 'KeyR', { ...ctrl, shiftKey: true }))).toBe(true);
  });

  it('leaves editing keys and plain typing alone', () => {
    for (const l of 'acvxyzl') {
      expect(isBrowserKey(press(l, `Key${l.toUpperCase()}`, ctrl))).toBe(false);
    }
    expect(isBrowserKey(press('p', 'KeyP'))).toBe(false);
    expect(isBrowserKey(press('P', 'KeyP', { shiftKey: true }))).toBe(false);
    expect(isBrowserKey(press('+', 'NumpadAdd'))).toBe(false);
    expect(isBrowserKey(press('Delete', 'Delete'))).toBe(false);
    expect(isBrowserKey(press('ArrowLeft', 'ArrowLeft'))).toBe(false);
    expect(isBrowserKey(press('Enter', 'Enter'))).toBe(false);
  });

  it('follows the typed letter on other Latin layouts (Dvorak C sits on the J key)', () => {
    expect(isBrowserKey(press('c', 'KeyJ', ctrl))).toBe(false);
  });

  it('uses the key position when the layout types Urdu', () => {
    expect(isBrowserKey(press('پ', 'KeyP', ctrl))).toBe(true);
  });

  it('takes zoom keys on the main row and the number pad', () => {
    expect(isBrowserKey(press('=', 'Equal', ctrl))).toBe(true);
    expect(isBrowserKey(press('+', 'Equal', { ...ctrl, shiftKey: true }))).toBe(true);
    expect(isBrowserKey(press('-', 'Minus', ctrl))).toBe(true);
    expect(isBrowserKey(press('0', 'Digit0', ctrl))).toBe(true);
    expect(isBrowserKey(press('+', 'NumpadAdd', ctrl))).toBe(true);
    expect(isBrowserKey(press('-', 'NumpadSubtract', ctrl))).toBe(true);
  });

  it('takes Alt+←/→ (back, forward) and Ctrl+Shift+Delete', () => {
    expect(isBrowserKey(press('ArrowLeft', 'ArrowLeft', { altKey: true }))).toBe(true);
    expect(isBrowserKey(press('ArrowRight', 'ArrowRight', { altKey: true }))).toBe(true);
    expect(isBrowserKey(press('Delete', 'Delete', { ...ctrl, shiftKey: true }))).toBe(true);
    expect(isBrowserKey(press('Delete', 'Delete', ctrl))).toBe(false);
  });
});

describe('keyLetter and keyDigit', () => {
  it('reads the letter typed, else the key position', () => {
    expect(keyLetter({ key: 'M', code: 'KeyM' })).toBe('m');
    expect(keyLetter({ key: 'µ', code: 'KeyM' })).toBe('m');
    expect(keyLetter({ key: 'Enter', code: 'Enter' })).toBe(null);
  });

  it('reads top-row digits only', () => {
    expect(keyDigit({ key: '1', code: 'Digit1' })).toBe('1');
    expect(keyDigit({ key: '!', code: 'Digit1' })).toBe('1');
    expect(keyDigit({ key: '1', code: 'Numpad1' })).toBe(null);
    expect(keyDigit({ key: 'a', code: 'KeyA' })).toBe(null);
  });
});
