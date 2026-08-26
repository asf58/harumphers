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
  ['/api/me', new Set(['GET', 'PATCH'])],
  ['/api/admin/events', new Set(['POST'])]
]);

const DYNAMIC_ROUTES = [
  {
    name: 'admin-member',
    pattern: /^\/api\/admin\/members\/(rec[A-Za-z0-9]{14})$/,
    methods: new Set(['PATCH'])
  },
  {
    name: 'member-rsvp',
    pattern: /^\/api\/events\/(rec[A-Za-z0-9]{14})\/rsvp$/,
    methods: new Set(['PUT'])
  }
];

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function requireExactKeys(value, expectedKeys, message = 'The submitted request is not valid.') {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...expectedKeys].sort().join(',')
  ) {
    throw new ApiError(400, 'VALIDATION_FAILED', message);
  }
}

async function readJsonBody(request, maxLength = MAX_LOGIN_BODY_LENGTH) {
  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (contentLength > maxLength) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted request is not valid.');
  }

  const text = await request.text();
  if (text.length === 0 || text.length > maxLength) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted request is not valid.');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted request is not valid.');
  }
}

function requireText(value, { allowEmpty = true, maxLength = 500 } = {}) {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.trim() === '')) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted request is not valid.');
  }
  return value.trim();
}

function validateProfile(body, isAdmin) {
  const keys = isAdmin
    ? ['name', 'phone', 'email', 'memberNumber', 'isAdmin']
    : ['name', 'phone', 'email'];
  requireExactKeys(body, keys);
  const value = {
    name: requireText(body.name, { allowEmpty: false, maxLength: 160 }),
    phone: requireText(body.phone, { maxLength: 40 }),
    email: requireText(body.email, { maxLength: 254 })
  };
  if (isAdmin) {
    if (!Number.isSafeInteger(body.memberNumber) || body.memberNumber <= 0 || body.memberNumber > 999999999) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted request is not valid.');
    }
    if (typeof body.isAdmin !== 'boolean') {
      throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted request is not valid.');
    }
    value.memberNumber = body.memberNumber;
    value.isAdmin = body.isAdmin;
  }
  return value;
}

function validateRsvp(body) {
  requireExactKeys(body, ['response', 'guests']);
  const response = requireText(body.response, { allowEmpty: false, maxLength: 10 }).toUpperCase();
  if (!['YES', 'NO', 'MAYBE'].includes(response) || !Number.isSafeInteger(body.guests) || body.guests < 0 || body.guests > 9) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted RSVP is not valid.');
  }
  return { response, guests: body.guests };
}

function validateEvent(body) {
  requireExactKeys(body, [
    'idempotencyKey', 'name', 'date', 'speaker', 'time', 'room', 'notes', 'status', 'enableGuests'
  ]);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.idempotencyKey)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted event is not valid.');
  }
  const value = {
    idempotencyKey: body.idempotencyKey.toLowerCase(),
    name: requireText(body.name, { allowEmpty: false, maxLength: 160 }),
    date: requireText(body.date, { maxLength: 10 }),
    speaker: requireText(body.speaker, { maxLength: 160 }),
    time: requireText(body.time, { maxLength: 40 }),
    room: requireText(body.room, { maxLength: 120 }),
    notes: requireText(body.notes, { maxLength: 2000 }),
    status: requireText(body.status, { allowEmpty: false, maxLength: 20 }),
    enableGuests: body.enableGuests
  };
  if (!['Suggested', 'Upcoming', 'Scheduled'].includes(value.status) || typeof value.enableGuests !== 'boolean') {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted event is not valid.');
  }
  if (value.date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted event is not valid.');
  }
  if (value.status === 'Scheduled' && value.date === '') {
    throw new ApiError(400, 'VALIDATION_FAILED', 'A date is required for a scheduled event.');
  }
  return value;
}

function matchRoute(pathname) {
  const methods = ROUTE_METHODS.get(pathname);
  if (methods) return { name: pathname, methods, params: [] };
  for (const route of DYNAMIC_ROUTES) {
    const match = pathname.match(route.pattern);
    if (match) return { name: route.name, methods: route.methods, params: match.slice(1) };
  }
  return null;
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
  const matchedRoute = matchRoute(pathname);
  if (!matchedRoute) {
    throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
  }
  if (!matchedRoute.methods.has(request.method)) {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'That method is not allowed.');
  }

  if (pathname === '/api/login/guest') {
    const body = await readJsonBody(request);
    requireExactKeys(body, ['phrase'], 'The submitted login is not valid.');
    if (!await credentialsMatch(body.phrase, env.GUEST_LOGIN, env.SESSION_SECRET)) throw loginFailed();
    return json({ token: await issueSession({ sub: 'guest', role: 'guest' }, env.SESSION_SECRET, nowSeconds) });
  }

  if (pathname === '/api/login/member') {
    const body = await readJsonBody(request);
    requireExactKeys(body, ['memberNumber'], 'The submitted login is not valid.');
    if (!Number.isSafeInteger(body.memberNumber) || body.memberNumber <= 0 || body.memberNumber > 999999999) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted login is not valid.');
    }
    const member = await airtable.findMemberByNumber(body.memberNumber);
    if (!member || typeof member.id !== 'string' || member.id === '') throw loginFailed();
    return json({ token: await issueSession({ sub: member.id, role: 'member' }, env.SESSION_SECRET, nowSeconds) });
  }

  if (pathname === '/api/login/admin') {
    const body = await readJsonBody(request);
    requireExactKeys(body, ['password'], 'The submitted login is not valid.');
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
    if (request.method === 'GET') return json(await airtable.getMember(session.sub));
    return json(await airtable.updateMemberProfile(session.sub, validateProfile(await readJsonBody(request), false)));
  }

  if (matchedRoute.name === 'admin-member') {
    requireRole(session, ['admin']);
    return json(await airtable.updateMember(matchedRoute.params[0], validateProfile(await readJsonBody(request), true)));
  }

  if (matchedRoute.name === 'member-rsvp') {
    requireRole(session, ['member']);
    return json(await airtable.setRsvp(session.sub, matchedRoute.params[0], validateRsvp(await readJsonBody(request))));
  }

  if (pathname === '/api/admin/events') {
    requireRole(session, ['admin']);
    return json(await airtable.createEvent(validateEvent(await readJsonBody(request))));
  }

  throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
}
