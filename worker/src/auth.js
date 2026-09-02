import { ApiError } from './errors.js';

const SESSION_SECONDS = 12 * 60 * 60;
const MAX_TOKEN_LENGTH = 4096;
const VALID_ROLES = new Set(['guest', 'member', 'admin']);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function invalidToken() {
  return new ApiError(401, 'SESSION_INVALID', 'invalid session token');
}

function validateSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('session secret is required');
  }
}

function validateIdentity(claims) {
  if (
    !claims
    || typeof claims.sub !== 'string'
    || claims.sub.trim() === ''
    || claims.sub.length > 256
    || !VALID_ROLES.has(claims.role)
  ) {
    throw new ApiError(401, 'SESSION_INVALID', 'invalid session claims');
  }
}

function encodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function encodeJson(value) {
  return encodeBytes(encoder.encode(JSON.stringify(value)));
}

function decodeBytes(value) {
  if (typeof value !== 'string' || value === '' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw invalidToken();
  }

  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');

  try {
    return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  } catch {
    throw invalidToken();
  }
}

function decodeJson(value) {
  try {
    return JSON.parse(decoder.decode(decodeBytes(value)));
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw invalidToken();
  }
}

async function importHmacKey(secret, usage) {
  validateSecret(secret);
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  );
}

export async function issueSession(claims, secret, nowSeconds) {
  validateIdentity(claims);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new TypeError('current time must be a non-negative integer');
  }

  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson({
    sub: claims.sub,
    role: claims.role,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_SECONDS
  });
  const signingInput = `${header}.${payload}`;
  const key = await importHmacKey(secret, 'sign');
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));

  return `${signingInput}.${encodeBytes(new Uint8Array(signature))}`;
}

export async function verifySession(token, secret, nowSeconds) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
    throw invalidToken();
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new TypeError('current time must be a non-negative integer');
  }

  const segments = token.split('.');
  if (segments.length !== 3 || segments.some(segment => segment === '')) {
    throw invalidToken();
  }

  const [headerSegment, payloadSegment, signatureSegment] = segments;
  const key = await importHmacKey(secret, 'verify');
  const signatureIsValid = await crypto.subtle.verify(
    'HMAC',
    key,
    decodeBytes(signatureSegment),
    encoder.encode(`${headerSegment}.${payloadSegment}`)
  );
  if (!signatureIsValid) {
    throw new ApiError(401, 'SESSION_INVALID', 'invalid session signature');
  }

  const header = decodeJson(headerSegment);
  if (
    !header
    || header.alg !== 'HS256'
    || header.typ !== 'JWT'
    || Object.keys(header).sort().join(',') !== 'alg,typ'
  ) {
    throw invalidToken();
  }

  const claims = decodeJson(payloadSegment);
  validateIdentity(claims);
  if (
    Object.keys(claims).sort().join(',') !== 'exp,iat,role,sub'
    || !Number.isSafeInteger(claims.iat)
    || !Number.isSafeInteger(claims.exp)
    || claims.iat < 0
    || claims.exp - claims.iat !== SESSION_SECONDS
    || claims.iat > nowSeconds
  ) {
    throw new ApiError(401, 'SESSION_INVALID', 'invalid session claims');
  }
  if (claims.exp <= nowSeconds) {
    throw new ApiError(401, 'SESSION_EXPIRED', 'session expired');
  }

  return claims;
}

export function requireRole(session, allowedRoles) {
  if (!session || !Array.isArray(allowedRoles) || !allowedRoles.includes(session.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'forbidden');
  }

  return session;
}
