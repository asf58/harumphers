import { issueSession, requireRole, verifySession } from './auth.js';
import { ApiError } from './errors.js';
import { validatePhotoPayload } from './photos.js';
import { hashPin, PIN_PATTERN, verifyPin } from './pin.js';

const MAX_LOGIN_BODY_LENGTH = 4096;
const encoder = new TextEncoder();
const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const MEMBER_ROLES = new Set(['member', 'admin', 'super_admin']);

const ROUTE_METHODS = new Map([
  ['/api/health', new Set(['GET'])],
  ['/api/login/guest', new Set(['POST'])],
  ['/api/login/member', new Set(['POST'])],
  ['/api/login/admin', new Set(['POST'])],
  ['/api/member-requests', new Set(['POST'])],
  ['/api/session', new Set(['GET'])],
  ['/api/directory', new Set(['GET'])],
  ['/api/events', new Set(['GET'])],
  ['/api/me', new Set(['GET', 'PATCH'])],
  ['/api/me/votes', new Set(['GET'])],
  ['/api/me/photo', new Set(['POST'])],
  ['/api/me/pin', new Set(['PUT'])],
  ['/api/admin/roster', new Set(['GET', 'POST'])],
  ['/api/admin/audit', new Set(['GET'])],
  ['/api/admin/events', new Set(['POST'])],
  ['/api/admin/member-requests', new Set(['GET'])],
  ['/api/admin/diagnostics/member-numbers', new Set(['GET'])],
  ['/api/admin/cache/refresh', new Set(['POST'])]
]);

const DYNAMIC_ROUTES = [
  {
    name: 'file',
    pattern: /^\/api\/files\/(att[A-Za-z0-9]{14})$/,
    methods: new Set(['GET'])
  },
  {
    name: 'admin-roster-member',
    pattern: /^\/api\/admin\/roster\/(rec[A-Za-z0-9]{14})$/,
    methods: new Set(['PATCH'])
  },
  {
    name: 'admin-roster-role',
    pattern: /^\/api\/admin\/roster\/(rec[A-Za-z0-9]{14})\/role$/,
    methods: new Set(['PUT'])
  },
  {
    name: 'admin-roster-pin',
    pattern: /^\/api\/admin\/roster\/(rec[A-Za-z0-9]{14})\/pin$/,
    methods: new Set(['PUT'])
  },
  {
    name: 'admin-event-roster',
    pattern: /^\/api\/admin\/events\/(rec[A-Za-z0-9]{14})\/roster$/,
    methods: new Set(['GET'])
  },
  {
    name: 'admin-member',
    pattern: /^\/api\/admin\/members\/(rec[A-Za-z0-9]{14})$/,
    methods: new Set(['PATCH'])
  },
  {
    name: 'member-rsvp',
    pattern: /^\/api\/events\/(rec[A-Za-z0-9]{14})\/rsvp$/,
    methods: new Set(['PUT'])
  },
  {
    name: 'admin-rsvp',
    pattern: /^\/api\/admin\/events\/(rec[A-Za-z0-9]{14})\/rsvps\/(rec[A-Za-z0-9]{14})$/,
    methods: new Set(['PUT'])
  },
  {
    name: 'admin-member-photo',
    pattern: /^\/api\/admin\/members\/(rec[A-Za-z0-9]{14})\/photo$/,
    methods: new Set(['POST'])
  },
  {
    name: 'member-vote',
    pattern: /^\/api\/events\/(rec[A-Za-z0-9]{14})\/vote$/,
    methods: new Set(['PUT'])
  },
  {
    name: 'admin-vote',
    pattern: /^\/api\/admin\/events\/(rec[A-Za-z0-9]{14})\/votes\/(rec[A-Za-z0-9]{14})$/,
    methods: new Set(['PUT'])
  },
  {
    name: 'event-photos',
    pattern: /^\/api\/events\/(rec[A-Za-z0-9]{14})\/photos$/,
    methods: new Set(['POST'])
  },
  {
    name: 'admin-photo',
    pattern: /^\/api\/admin\/photos\/(rec[A-Za-z0-9]{14})$/,
    methods: new Set(['DELETE', 'PATCH'])
  },
  {
    name: 'admin-event',
    pattern: /^\/api\/admin\/events\/(rec[A-Za-z0-9]{14})$/,
    methods: new Set(['PATCH'])
  },
  {
    name: 'admin-event-photo',
    pattern: /^\/api\/admin\/events\/(rec[A-Za-z0-9]{14})\/speaker-photo$/,
    methods: new Set(['POST', 'DELETE'])
  },
  {
    name: 'admin-attendance',
    pattern: /^\/api\/admin\/events\/(rec[A-Za-z0-9]{14})\/attendance$/,
    methods: new Set(['PUT'])
  },
  {
    name: 'admin-member-request-approve',
    pattern: /^\/api\/admin\/member-requests\/(rec[A-Za-z0-9]{14})\/approve$/,
    methods: new Set(['POST'])
  },
  {
    name: 'admin-member-request-reject',
    pattern: /^\/api\/admin\/member-requests\/(rec[A-Za-z0-9]{14})\/reject$/,
    methods: new Set(['POST'])
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
    ? ['name', 'phone', 'email', 'memberNumber']
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
    value.memberNumber = body.memberNumber;
  }
  return value;
}

function validateRsvp(body) {
  requireExactKeys(body, ['response', 'guests']);
  const response = body.response === null
    ? null
    : requireText(body.response, { allowEmpty: false, maxLength: 10 }).toUpperCase();
  if ((response !== null && !['YES', 'NO', 'MAYBE'].includes(response)) || !Number.isSafeInteger(body.guests) || body.guests < 0 || body.guests > 9) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted RSVP is not valid.');
  }
  return { response, guests: body.guests };
}

function validateEvent(body) {
  requireExactKeys(body, [
    'idempotencyKey', 'name', 'date', 'speaker', 'time', 'room', ...(body && Object.hasOwn(body, 'location') ? ['location'] : []), 'notes', 'status', 'enableGuests'
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
    ...(body.location !== undefined ? { location: requireText(body.location, { maxLength: 300 }) } : {}),
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

function validateMemberRequest(body) {
  requireExactKeys(body, ['name', 'memberNumber']);
  if (!Number.isSafeInteger(body.memberNumber) || body.memberNumber <= 0 || body.memberNumber > 999999999) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted member request is not valid.');
  }
  return {
    name: requireText(body.name, { allowEmpty: false, maxLength: 160 }),
    memberNumber: body.memberNumber
  };
}

function validateRosterMember(body) {
  requireExactKeys(body, ['name', 'phone', 'email', 'memberNumber', 'inDirectory', 'homeAddress', 'notes']);
  if (
    (body.memberNumber !== null && (!Number.isSafeInteger(body.memberNumber) || body.memberNumber <= 0 || body.memberNumber > 999999999))
    || typeof body.inDirectory !== 'boolean'
  ) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted member is not valid.');
  }
  return {
    name: requireText(body.name, { allowEmpty: false, maxLength: 160 }),
    phone: requireText(body.phone, { maxLength: 40 }),
    email: requireText(body.email, { maxLength: 254 }),
    memberNumber: body.memberNumber,
    inDirectory: body.inDirectory,
    homeAddress: requireText(body.homeAddress, { maxLength: 500 }),
    notes: requireText(body.notes, { maxLength: 5000 })
  };
}

function validateRole(body) {
  requireExactKeys(body, ['role']);
  if (!MEMBER_ROLES.has(body.role)) throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted role is not valid.');
  return body.role;
}

function validatePinValue(value, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  if (typeof value !== 'string' || !PIN_PATTERN.test(value)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'A PIN must be 4 to 8 digits.');
  }
  return value;
}

function validateVote(body) {
  requireExactKeys(body, ['vote']);
  if (body.vote !== null && body.vote !== 'UP' && body.vote !== 'DOWN') {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted vote is not valid.');
  }
  return body.vote;
}

function validateMemberLink(body) {
  requireExactKeys(body, ['memberId']);
  if (typeof body.memberId !== 'string' || !/^rec[A-Za-z0-9]{14}$/.test(body.memberId)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The selected member is not valid.');
  }
  return body.memberId;
}

function validateEventUpdate(body) {
  requireExactKeys(body, ['name', 'date', 'speaker', 'time', 'room', ...(body && Object.hasOwn(body, 'location') ? ['location'] : []), 'notes', 'status']);
  const value = {
    name: requireText(body.name, { allowEmpty: false, maxLength: 160 }),
    date: requireText(body.date, { maxLength: 10 }),
    speaker: requireText(body.speaker, { maxLength: 160 }),
    time: requireText(body.time, { maxLength: 40 }),
    room: requireText(body.room, { maxLength: 120 }),
    ...(body.location !== undefined ? { location: requireText(body.location, { maxLength: 300 }) } : {}),
    notes: requireText(body.notes, { maxLength: 2000 }),
    status: requireText(body.status, { allowEmpty: false, maxLength: 20 })
  };
  if (!['Suggested', 'Upcoming', 'Scheduled', 'Completed', 'Cancelled'].includes(value.status)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted event is not valid.');
  }
  if (value.date && !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted event is not valid.');
  }
  if (value.status === 'Scheduled' && !value.date) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'A date is required for a scheduled event.');
  }
  return value;
}

function validateAttendance(body) {
  requireExactKeys(body, ['entries']);
  if (!Array.isArray(body.entries) || body.entries.length > 200) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted attendance is not valid.');
  }
  return body.entries.map(entry => {
    requireExactKeys(entry, ['memberId', 'attended', 'actualGuests']);
    if (
      typeof entry.memberId !== 'string'
      || !/^rec[A-Za-z0-9]{14}$/.test(entry.memberId)
      || typeof entry.attended !== 'boolean'
      || !Number.isSafeInteger(entry.actualGuests)
      || entry.actualGuests < 0
      || entry.actualGuests > 9
    ) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted attendance is not valid.');
    }
    return entry;
  });
}

function validateCaption(body) {
  requireExactKeys(body, ['caption']);
  return requireText(body.caption, { maxLength: 500 });
}

function validatePhoto(body, withCaption = false) {
  const expected = withCaption
    ? ['filename', 'contentType', 'base64', 'caption']
    : ['filename', 'contentType', 'base64'];
  requireExactKeys(body, expected);
  const validated = validatePhotoPayload({
    filename: body.filename,
    contentType: body.contentType,
    base64: body.base64
  });
  return {
    filename: validated.filename,
    contentType: validated.contentType,
    base64: body.base64,
    ...(withCaption ? { caption: requireText(body.caption, { maxLength: 500 }) } : {})
  };
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

function hasMemberIdentity(session) {
  return /^rec[A-Za-z0-9]{14}$/.test(session?.sub ?? '');
}

function requireSuperAdmin(session) {
  requireRole(session, ['admin']);
  if (session.adminLevel !== 'super_admin') {
    throw new ApiError(403, 'FORBIDDEN', 'Only a super admin can do that.');
  }
  return session;
}

// A member's admin level lives in the database, so a demotion takes effect on the next request
// instead of waiting for the 12-hour session to expire.
async function withAdminLevel(session, store) {
  if (session.role !== 'admin') return { ...session, adminLevel: null };
  if (!hasMemberIdentity(session) || typeof store.getMemberAccess !== 'function') {
    return { ...session, adminLevel: 'admin' };
  }
  const access = await store.getMemberAccess(session.sub);
  if (!access) throw new ApiError(401, 'SESSION_INVALID', 'Please sign in again.');
  if (!ADMIN_ROLES.has(access.role)) return { ...session, role: 'member', adminLevel: null };
  return { ...session, adminLevel: access.role };
}

function auditAction(matchedRoute, method, pathname) {
  const name = matchedRoute.name.startsWith('/api/') ? pathname.replace('/api/admin/', 'admin-') : matchedRoute.name;
  return `${name} ${method}`;
}

function requireMemberIdentity(session) {
  requireRole(session, ['member', 'admin']);
  if (!hasMemberIdentity(session)) {
    throw new ApiError(403, 'FORBIDDEN', 'That action is not allowed.');
  }
  return session;
}

async function enforceRateLimit(binding, key) {
  if (!binding || typeof binding.limit !== 'function') {
    throw new ApiError(500, 'CONFIGURATION_ERROR', 'The app abuse protection is not configured.');
  }
  let result;
  try {
    result = await binding.limit({ key });
  } catch {
    throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', 'The app abuse protection is temporarily unavailable.');
  }
  if (result?.success !== true) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Please wait one minute and try again.');
  }
}

function requesterKey(request, pathname) {
  return `${pathname}:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
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

  if (pathname === '/api/health') {
    return json({ ok: true, service: 'harumphers-api' });
  }

  if (pathname === '/api/login/guest') {
    await enforceRateLimit(env.AUTH_RATE_LIMITER, requesterKey(request, pathname));
    const body = await readJsonBody(request);
    requireExactKeys(body, ['phrase'], 'The submitted login is not valid.');
    if (!await credentialsMatch(body.phrase, env.GUEST_LOGIN, env.SESSION_SECRET)) throw loginFailed();
    return json({ token: await issueSession({ sub: 'guest', role: 'guest' }, env.SESSION_SECRET, nowSeconds) });
  }

  if (pathname === '/api/login/member') {
    await enforceRateLimit(env.AUTH_RATE_LIMITER, requesterKey(request, pathname));
    const body = await readJsonBody(request);
    const withPin = Boolean(body) && typeof body === 'object' && Object.hasOwn(body, 'pin');
    requireExactKeys(body, withPin ? ['memberNumber', 'pin'] : ['memberNumber'], 'The submitted login is not valid.');
    if (!Number.isSafeInteger(body.memberNumber) || body.memberNumber <= 0 || body.memberNumber > 999999999) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted login is not valid.');
    }
    if (withPin) validatePinValue(body.pin);
    const member = await airtable.findMemberByNumber(body.memberNumber);
    if (!member || typeof member.id !== 'string' || member.id === '') throw loginFailed();
    let role = member.fields?.['IS ADMIN'] === true ? 'admin' : 'member';
    if (typeof airtable.getMemberAccess === 'function') {
      // Admin power needs the member's PIN; without one (or before one is set) the login is a member login.
      const access = await airtable.getMemberAccess(member.id);
      role = 'member';
      if (access && ADMIN_ROLES.has(access.role) && access.pinHash) {
        if (!withPin) throw new ApiError(401, 'PIN_REQUIRED', 'Enter your admin PIN.');
        if (access.locked) {
          throw new ApiError(429, 'PIN_LOCKED', 'Too many incorrect PINs. Please wait 15 minutes and try again.');
        }
        if (!await verifyPin(body.pin, access.pinHash)) {
          await airtable.recordPinFailure(member.id);
          throw new ApiError(401, 'PIN_INCORRECT', 'That PIN is not correct.');
        }
        role = 'admin';
      }
      await airtable.recordLogin(member.id);
    }
    return json({ token: await issueSession({ sub: member.id, role }, env.SESSION_SECRET, nowSeconds) });
  }

  if (pathname === '/api/login/admin') {
    await enforceRateLimit(env.AUTH_RATE_LIMITER, requesterKey(request, pathname));
    const body = await readJsonBody(request);
    requireExactKeys(body, ['password'], 'The submitted login is not valid.');
    if (!await credentialsMatch(body.password, env.ADMIN_LOGIN, env.SESSION_SECRET)) throw loginFailed();
    return json({ token: await issueSession({ sub: 'admin', role: 'admin' }, env.SESSION_SECRET, nowSeconds) });
  }

  // Image URLs are unguessable ids, like Airtable's attachment URLs, so <img> tags can load them.
  if (matchedRoute.name === 'file') {
    if (typeof airtable.getFile !== 'function') {
      throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
    }
    const file = await airtable.getFile(matchedRoute.params[0]);
    return new Response(file.body, {
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': file.contentType,
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }

  if (pathname === '/api/member-requests') {
    const value = validateMemberRequest(await readJsonBody(request));
    await enforceRateLimit(env.MEMBER_REQUEST_RATE_LIMITER, requesterKey(request, pathname));
    await enforceRateLimit(env.MEMBER_REQUEST_RATE_LIMITER, `member-number:${value.memberNumber}`);
    return json(await airtable.submitMemberRequest(value), 201);
  }

  const session = await withAdminLevel(await requireSession(request, env, nowSeconds), airtable);
  const audit = { detail: {} };
  const response = await routeSessionRequest(request, airtable, session, matchedRoute, pathname, audit);
  if (request.method !== 'GET' && pathname.startsWith('/api/admin/') && typeof airtable.audit === 'function') {
    try {
      await airtable.audit(session, auditAction(matchedRoute, request.method, pathname), audit.targetId ?? matchedRoute.params[0] ?? null, {
        params: matchedRoute.params,
        ...audit.detail
      });
    } catch (error) {
      // The change itself succeeded; record the gap in Workers Logs rather than failing the request.
      console.error('audit log write failed', matchedRoute.name, error?.message);
    }
  }
  return response;
}

async function routeSessionRequest(request, airtable, session, matchedRoute, pathname, audit) {
  if (pathname === '/api/session') {
    return json({ role: session.role, hasMemberIdentity: hasMemberIdentity(session), adminLevel: session.adminLevel });
  }

  if (pathname === '/api/me/pin') {
    requireMemberIdentity(session);
    requireRole(session, ['admin']);
    const body = await readJsonBody(request);
    requireExactKeys(body, ['currentPin', 'newPin']);
    const access = await airtable.getMemberAccess(session.sub);
    if (!await verifyPin(validatePinValue(body.currentPin), access?.pinHash)) {
      throw new ApiError(403, 'PIN_INCORRECT', 'Your current PIN is not correct.');
    }
    await airtable.setMemberPin(session.sub, await hashPin(validatePinValue(body.newPin)));
    return json({ changed: true });
  }

  if (pathname === '/api/admin/roster') {
    requireRole(session, ['admin']);
    if (request.method === 'GET') return json(await airtable.getRoster());
    const created = await airtable.saveRosterMember(null, { ...validateRosterMember(await readJsonBody(request, 20_000)), actorId: session.sub });
    audit.targetId = created.id;
    return json(created, 201);
  }

  if (matchedRoute.name === 'admin-roster-member') {
    requireRole(session, ['admin']);
    return json(await airtable.saveRosterMember(
      matchedRoute.params[0],
      { ...validateRosterMember(await readJsonBody(request, 20_000)), actorId: session.sub }
    ));
  }

  if (matchedRoute.name === 'admin-roster-role') {
    requireSuperAdmin(session);
    const role = validateRole(await readJsonBody(request));
    const { members } = await airtable.getRoster();
    const target = members.find(member => member.id === matchedRoute.params[0]);
    if (!target) throw new ApiError(404, 'NOT_FOUND', 'The member record was not found.');
    if (target.role === 'super_admin' && role !== 'super_admin'
      && members.filter(member => member.role === 'super_admin').length <= 1) {
      throw new ApiError(409, 'LAST_SUPER_ADMIN', 'There must always be at least one super admin.');
    }
    audit.detail = { from: target.role, to: role };
    return json(await airtable.setMemberRole(matchedRoute.params[0], role));
  }

  if (matchedRoute.name === 'admin-roster-pin') {
    requireSuperAdmin(session);
    const body = await readJsonBody(request);
    requireExactKeys(body, ['pin']);
    const pin = validatePinValue(body.pin, { allowNull: true });
    audit.detail = { pin: pin === null ? 'cleared' : 'set' };
    return json(await airtable.setMemberPin(matchedRoute.params[0], pin === null ? null : await hashPin(pin)));
  }

  if (matchedRoute.name === 'admin-event-roster') {
    requireRole(session, ['admin']);
    return json(await airtable.getEventRoster(matchedRoute.params[0]));
  }

  if (pathname === '/api/admin/audit') {
    requireRole(session, ['admin']);
    return json(await airtable.getAuditLog());
  }

  if (pathname === '/api/directory') {
    return json(await airtable.getDirectory(session.role));
  }

  if (pathname === '/api/events') {
    return json(await airtable.getEventsBootstrap(session.role));
  }

  if (pathname === '/api/me') {
    requireMemberIdentity(session);
    if (request.method === 'GET') return json(await airtable.getMember(session.sub));
    return json(await airtable.updateMemberProfile(session.sub, validateProfile(await readJsonBody(request), false)));
  }

  if (pathname === '/api/me/votes') {
    requireMemberIdentity(session);
    return json(await airtable.getMemberVotes(session.sub));
  }

  if (pathname === '/api/me/photo') {
    requireMemberIdentity(session);
    return json(await airtable.uploadMemberPhoto(session.sub, validatePhoto(await readJsonBody(request, 1_500_000))));
  }

  if (matchedRoute.name === 'admin-member') {
    requireRole(session, ['admin']);
    return json(await airtable.updateMember(matchedRoute.params[0], validateProfile(await readJsonBody(request), true)));
  }

  if (matchedRoute.name === 'admin-member-photo') {
    requireRole(session, ['admin']);
    return json(await airtable.uploadMemberPhoto(
      matchedRoute.params[0],
      validatePhoto(await readJsonBody(request, 1_500_000))
    ));
  }

  if (matchedRoute.name === 'member-rsvp') {
    requireMemberIdentity(session);
    return json(await airtable.setRsvp(session.sub, matchedRoute.params[0], validateRsvp(await readJsonBody(request)), { admin: session.role === 'admin' }));
  }

  if (matchedRoute.name === 'admin-rsvp') {
    requireRole(session, ['admin']);
    return json(await airtable.setRsvp(matchedRoute.params[1], matchedRoute.params[0], validateRsvp(await readJsonBody(request)), { admin: true }));
  }

  if (matchedRoute.name === 'member-vote') {
    requireMemberIdentity(session);
    return json(await airtable.setVote(session.sub, matchedRoute.params[0], validateVote(await readJsonBody(request))));
  }

  if (matchedRoute.name === 'admin-vote') {
    requireRole(session, ['admin']);
    return json(await airtable.setVote(matchedRoute.params[1], matchedRoute.params[0], validateVote(await readJsonBody(request))));
  }

  if (matchedRoute.name === 'event-photos') {
    requireRole(session, ['member', 'admin']);
    return json(await airtable.addEventPhoto(
      session,
      matchedRoute.params[0],
      validatePhoto(await readJsonBody(request, 1_500_000), true)
    ), 201);
  }

  if (matchedRoute.name === 'admin-photo') {
    requireRole(session, ['admin']);
    if (request.method === 'DELETE') return json(await airtable.deletePhoto(matchedRoute.params[0]));
    return json(await airtable.updatePhotoCaption(matchedRoute.params[0], validateCaption(await readJsonBody(request))));
  }

  if (matchedRoute.name === 'admin-event') {
    requireRole(session, ['admin']);
    return json(await airtable.updateEvent(matchedRoute.params[0], validateEventUpdate(await readJsonBody(request))));
  }

  if (matchedRoute.name === 'admin-event-photo') {
    requireRole(session, ['admin']);
    if (request.method === 'DELETE') return json(await airtable.clearEventPhoto(matchedRoute.params[0]));
    return json(await airtable.uploadEventPhoto(
      matchedRoute.params[0],
      validatePhoto(await readJsonBody(request, 1_500_000))
    ));
  }

  if (matchedRoute.name === 'admin-attendance') {
    requireRole(session, ['admin']);
    return json(await airtable.saveAttendance(matchedRoute.params[0], validateAttendance(await readJsonBody(request))));
  }

  if (matchedRoute.name === 'admin-member-request-approve') {
    requireRole(session, ['admin']);
    return json(await airtable.approveMemberRequest(
      matchedRoute.params[0],
      validateMemberLink(await readJsonBody(request))
    ));
  }

  if (matchedRoute.name === 'admin-member-request-reject') {
    requireRole(session, ['admin']);
    requireExactKeys(await readJsonBody(request), []);
    return json(await airtable.rejectMemberRequest(matchedRoute.params[0]));
  }

  if (pathname === '/api/admin/events') {
    requireRole(session, ['admin']);
    return json(await airtable.createEvent(validateEvent(await readJsonBody(request))));
  }

  if (pathname === '/api/admin/member-requests') {
    requireRole(session, ['admin']);
    return json(await airtable.getMemberRequests());
  }

  if (pathname === '/api/admin/diagnostics/member-numbers') {
    requireRole(session, ['admin']);
    return json(await airtable.getMemberNumberDiagnostics());
  }

  if (pathname === '/api/admin/cache/refresh') {
    requireRole(session, ['admin']);
    requireExactKeys(await readJsonBody(request), []);
    return json(await airtable.refreshCaches());
  }

  throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
}
