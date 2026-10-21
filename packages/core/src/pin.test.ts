import { describe, expect, it } from 'vitest';
import { hashPin, isValidPin, verifyPin } from './pin';

// Fewer iterations keep the tests fast; the format and checks are the same.
const FAST = 1_000;

describe('PINs', () => {
  it('accepts 4 to 6 digits only', () => {
    expect(['1234', '123456'].every(isValidPin)).toBe(true);
    expect(['123', '1234567', '12a4', ' 1234', ''].some(isValidPin)).toBe(false);
  });

  it('verifies the right PIN and rejects others', async () => {
    const stored = await hashPin('2580', FAST);
    expect(stored).toMatch(/^pbkdf2-sha256\$1000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPin('2580', stored)).toBe(true);
    expect(await verifyPin('2581', stored)).toBe(false);
    expect(await verifyPin('25800', stored)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPin('2580', FAST)).not.toBe(await hashPin('2580', FAST));
  });

  it('rejects malformed stored values and invalid PINs', async () => {
    expect(await verifyPin('2580', 'plain-text')).toBe(false);
    expect(await verifyPin('2580', 'md5$1$a$b')).toBe(false);
    await expect(hashPin('12')).rejects.toThrow();
  });
});
