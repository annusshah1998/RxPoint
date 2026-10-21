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

describe('PIN rules', () => {
  it('rejects weak PINs', async () => {
    const { pinProblem } = await import('./pin');
    expect(pinProblem('1111')).toBe('weak');
    expect(pinProblem('1234')).toBe('weak');
    expect(pinProblem('654321')).toBe('weak');
    expect(pinProblem('2580')).toBeNull();
    expect(pinProblem('12a4')).toBe('format');
    expect(pinProblem('2580', { owner: true })).toBe('format');
    expect(pinProblem('258014', { owner: true })).toBeNull();
  });

  it('locks out after repeated failures', async () => {
    const { lockUntil, isLocked } = await import('./pin');
    const now = new Date('2026-10-21T09:00:00Z');
    expect(lockUntil(4, now)).toBeNull();
    expect(lockUntil(5, now)?.toISOString()).toBe('2026-10-21T09:01:00.000Z');
    expect(lockUntil(6, now)).toBeNull();
    expect(lockUntil(10, now)?.toISOString()).toBe('2026-10-21T09:05:00.000Z');
    expect(lockUntil(20, now)?.toISOString()).toBe('2026-10-21T09:15:00.000Z');
    expect(isLocked('2026-10-21T09:01:00.000Z', now)).toBe(true);
    expect(isLocked('2026-10-21T08:59:00.000Z', now)).toBe(false);
    // A lock far in the future means the clock went back: ignore it.
    expect(isLocked('2026-10-23T09:00:00.000Z', now)).toBe(false);
  });

  it('makes and checks recovery codes', async () => {
    const { generateRecoveryCode, hashSecret, verifySecret, normalizeRecoveryCode } =
      await import('./pin');
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code).not.toMatch(/[01OIL]/);
    const stored = await hashSecret(normalizeRecoveryCode(code), 1000);
    expect(
      await verifySecret(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ' ')), stored),
    ).toBe(true);
    expect(await verifySecret('WRONGCODE', stored)).toBe(false);
  });
});
