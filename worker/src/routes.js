import { issueSession, requireRole, verifySession } from './auth.js';
import { ApiError } from './errors.js';

const MAX_LOGIN_BODY_LENGTH = 4096;
const encoder = new TextEncoder();

const ROUTE_METHODS = new Map([
  ['/api/login/guest', new Set(['POST'])],
  ['/api/login/member', new Set(['POST'])],
  ['/api/login/admin', new Set(['POST'])],
  ['/api/session', new Set(['GET'])],
  ['/api/directory', new Set(['GET'])],
  ['/api/events', new Set(['GET'])],
  ['/api/me', new Set(['GET'])]
]);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function requireExactKeys(value, expectedKeys) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...expectedKeys].sort().join(',')
  ) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted login is not valid.');
  }
}

async function readLoginBody(request) {
  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (contentLength > MAX_LOGIN_BODY_LENGTH) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted login is not valid.');
  }

  const text = await request.text();
  if (text.length === 0 || text.length > MAX_LOGIN_BODY_LENGTH) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted login is not valid.');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted login is not valid.');
  }
}

async function credentialsMatch(provided, expected, secret) {
  if (
    typeof provided !== 'string'
    || typeof expected !== 'string'
    || provided.length === 0
    || provided.length > 256
    || expected.length === 0
  ) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  const expectedSignature = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
  return crypto.subtle.verify('HMAC', key, expectedSignature, encoder.encode(provided));
}

async function requireSession(request, env, nowSeconds) {
  const authorization = request.headers.get('Authorization');
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._-]+)$/);
  if (!match) {
    throw new ApiError(401, 'SESSION_REQUIRED', 'Please sign in again.');
  }

  return verifySession(match[1], env.SESSION_SECRET, nowSeconds);
}

function loginFailed() {
  return new ApiError(401, 'LOGIN_FAILED', 'The login was not recognized.');
}

export async function routeRequest(request, env, airtable, nowSeconds) {
  const { pathname } = new URL(request.url);
  const allowedMethods = ROUTE_METHODS.get(pathname);
  if (!allowedMethods) {
    throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
  }
  if (!allowedMethods.has(request.method)) {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'That method is not allowed.');
  }

  if (pathname === '/api/login/guest') {
    const body = await readLoginBody(request);
    requireExactKeys(body, ['phrase']);
    if (!await credentialsMatch(body.phrase, env.GUEST_LOGIN, env.SESSION_SECRET)) throw loginFailed();
    return json({ token: await issueSession({ sub: 'guest', role: 'guest' }, env.SESSION_SECRET, nowSeconds) });
  }

  if (pathname === '/api/login/member') {
    const body = await readLoginBody(request);
    requireExactKeys(body, ['memberNumber']);
    if (!Number.isSafeInteger(body.memberNumber) || body.memberNumber <= 0 || body.memberNumber > 999999999) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted login is not valid.');
    }
    const member = await airtable.findMemberByNumber(body.memberNumber);
    if (!member || typeof member.id !== 'string' || member.id === '') throw loginFailed();
    return json({ token: await issueSession({ sub: member.id, role: 'member' }, env.SESSION_SECRET, nowSeconds) });
  }

  if (pathname === '/api/login/admin') {
    const body = await readLoginBody(request);
    requireExactKeys(body, ['password']);
    if (!await credentialsMatch(body.password, env.ADMIN_LOGIN, env.SESSION_SECRET)) throw loginFailed();
    return json({ token: await issueSession({ sub: 'admin', role: 'admin' }, env.SESSION_SECRET, nowSeconds) });
  }

  const session = await requireSession(request, env, nowSeconds);

  if (pathname === '/api/session') {
    return json({ role: session.role });
  }

  if (pathname === '/api/directory') {
    return json(await airtable.getDirectory(session.role));
  }

  if (pathname === '/api/events') {
    return json(await airtable.getEventsBootstrap(session.role));
  }

  if (pathname === '/api/me') {
    requireRole(session, ['member']);
    return json(await airtable.getMember(session.sub));
  }

  throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
}
