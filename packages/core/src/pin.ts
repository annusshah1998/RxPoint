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
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derive(pin, salt, iterations);
  return `${ALGORITHM}$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Compares in constant time over the hash bytes. Returns false for malformed stored values. */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [algorithm, iterationsText, saltText, hashText] = stored.split('$');
  const iterations = Number(iterationsText);
  if (algorithm !== ALGORITHM || !Number.isInteger(iterations) || !saltText || !hashText) {
    return false;
  }
  if (!isValidPin(pin)) return false;
  const expected = fromBase64(hashText);
  const actual = await derive(pin, fromBase64(saltText), iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}
