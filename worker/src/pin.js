// Admin PINs are stored as PBKDF2-SHA256 hashes: pbkdf2$<iterations>$<salt>$<hash> (base64url).
// 100,000 iterations is the Cloudflare Workers maximum for PBKDF2.

const ITERATIONS = 100_000;
const encoder = new TextEncoder();

export const PIN_PATTERN = /^\d{4,8}$/;

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

async function derive(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPin(pin) {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) throw new TypeError('PIN must be 4 to 8 digits');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(await derive(pin, salt, ITERATIONS))}`;
}

export async function verifyPin(pin, stored) {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin) || typeof stored !== 'string') return false;
  const [scheme, iterationText, saltText, hashText] = stored.split('$');
  const iterations = Number(iterationText);
  if (scheme !== 'pbkdf2' || !Number.isSafeInteger(iterations) || iterations <= 0 || !saltText || !hashText) return false;
  const expected = fromBase64Url(hashText);
  const actual = await derive(pin, fromBase64Url(saltText), iterations);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}
