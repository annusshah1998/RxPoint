/**
 * Staff PINs, hashed with PBKDF2-SHA-256 and a random salt (Web Crypto, so it works
 * offline in the desktop app, the browser preview and tests).
 *
 * A 4–6 digit PIN can't resist an attacker who copies the database file, however it is
 * hashed; the hash keeps PINs from being read directly, and login lockout (in the
 * services) stops guessing at the till.
 *
 * Stored format: "pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>"
 */
export const PIN_PATTERN = /^\d{4,6}$/;

const ALGORITHM = 'pbkdf2-sha256';
export const PIN_ITERATIONS = 120_000;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export function isValidPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

export async function hashPin(pin: string, iterations = PIN_ITERATIONS): Promise<string> {
  if (!isValidPin(pin)) throw new RangeError('PIN must be 4 to 6 digits');
  return hashSecret(pin, iterations);
}

/** Compares in constant time over the hash bytes. Returns false for malformed stored values. */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  if (!isValidPin(pin)) return false;
  return verifySecret(pin, stored);
}

/** Same hashing for any secret (e.g. the owner recovery code), without the digit rule. */
export async function hashSecret(secret: string, iterations = PIN_ITERATIONS): Promise<string> {
  if (!secret) throw new RangeError('secret must not be empty');
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derive(secret, salt, iterations);
  return `${ALGORITHM}$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [algorithm, iterationsText, saltText, hashText] = stored.split('$');
  const iterations = Number(iterationsText);
  if (algorithm !== ALGORITHM || !Number.isInteger(iterations) || !saltText || !hashText) {
    return false;
  }
  if (!secret) return false;
  const expected = fromBase64(hashText);
  const actual = await derive(secret, fromBase64(saltText), iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

/**
 * Why a new PIN isn't acceptable: wrong format, or too easy to guess (all one digit,
 * or a straight run like 1234 / 4321). Owners need 6 digits.
 */
export function pinProblem(
  pin: string,
  options: { owner?: boolean } = {},
): 'format' | 'weak' | null {
  if (!isValidPin(pin)) return 'format';
  if (options.owner && pin.length !== 6) return 'format';
  const digits = Array.from(pin, Number);
  if (digits.every((d) => d === digits[0])) return 'weak';
  const steps = digits.slice(1).map((d, i) => d - digits[i]!);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'weak';
  return null;
}

/**
 * How long a user is locked out after `failedCount` wrong PINs in a row:
 * 5 → 1 minute, 10 → 5 minutes, 15 and every 5 after → 15 minutes. Null: not locked.
 */
export function lockUntil(failedCount: number, now: Date): Date | null {
  if (failedCount < 5 || failedCount % 5 !== 0) return null;
  const minutes = failedCount === 5 ? 1 : failedCount === 10 ? 5 : 15;
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * Whether a stored lock is still in force. A lock more than 15 minutes in the future
 * means the clock went back; it is ignored rather than locking someone out for days.
 */
export function isLocked(lockedUntil: string | null, now: Date): boolean {
  if (!lockedUntil) return false;
  const until = Date.parse(lockedUntil);
  if (Number.isNaN(until)) return false;
  const left = until - now.getTime();
  return left > 0 && left <= 15 * 60_000;
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A one-time owner recovery code like "7K4Q-9XMP-2RTD" (no 0/O or 1/I/L to misread). */
export function generateRecoveryCode(): string {
  const n = RECOVERY_ALPHABET.length;
  // Reject bytes past the last whole multiple of n, so every character is equally likely.
  const limit = 256 - (256 % n);
  const chars: string[] = [];
  const byte = new Uint8Array(1);
  while (chars.length < 12) {
    crypto.getRandomValues(byte);
    if (byte[0]! < limit) chars.push(RECOVERY_ALPHABET[byte[0]! % n]!);
  }
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

/** Normalises a typed recovery code: case, spaces and dashes don't matter. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
