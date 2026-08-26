import { issueSession, requireRole, verifySession } from './auth.js';
import { ApiError } from './errors.js';
import { validatePhotoPayload } from './photos.js';

const MAX_LOGIN_BODY_LENGTH = 4096;
const encoder = new TextEncoder();

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
  ['/api/admin/events', new Set(['POST'])],
  ['/api/admin/member-requests', new Set(['GET'])],
  ['/api/admin/diagnostics/member-numbers', new Set(['GET'])],
  ['/api/admin/cache/refresh', new Set(['POST'])]
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
  requireExactKeys(body, ['name', 'date', 'speaker', 'time', 'room', 'notes', 'status']);
  const value = {
    name: requireText(body.name, { allowEmpty: false, maxLength: 160 }),
    date: requireText(body.date, { maxLength: 10 }),
    speaker: requireText(body.speaker, { maxLength: 160 }),
    time: requireText(body.time, { maxLength: 40 }),
    room: requireText(body.room, { maxLength: 120 }),
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
    requireExactKeys(body, ['memberNumber'], 'The submitted login is not valid.');
    if (!Number.isSafeInteger(body.memberNumber) || body.memberNumber <= 0 || body.memberNumber > 999999999) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted login is not valid.');
    }
    const member = await airtable.findMemberByNumber(body.memberNumber);
    if (!member || typeof member.id !== 'string' || member.id === '') throw loginFailed();
    return json({ token: await issueSession({ sub: member.id, role: 'member' }, env.SESSION_SECRET, nowSeconds) });
  }

  if (pathname === '/api/login/admin') {
    await enforceRateLimit(env.AUTH_RATE_LIMITER, requesterKey(request, pathname));
    const body = await readJsonBody(request);
    requireExactKeys(body, ['password'], 'The submitted login is not valid.');
    if (!await credentialsMatch(body.password, env.ADMIN_LOGIN, env.SESSION_SECRET)) throw loginFailed();
    return json({ token: await issueSession({ sub: 'admin', role: 'admin' }, env.SESSION_SECRET, nowSeconds) });
  }

  if (pathname === '/api/member-requests') {
    const value = validateMemberRequest(await readJsonBody(request));
    await enforceRateLimit(env.MEMBER_REQUEST_RATE_LIMITER, requesterKey(request, pathname));
    await enforceRateLimit(env.MEMBER_REQUEST_RATE_LIMITER, `member-number:${value.memberNumber}`);
    return json(await airtable.submitMemberRequest(value), 201);
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

  if (pathname === '/api/me/votes') {
    requireRole(session, ['member']);
    return json(await airtable.getMemberVotes(session.sub));
  }

  if (pathname === '/api/me/photo') {
    requireRole(session, ['member']);
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
    requireRole(session, ['member']);
    return json(await airtable.setRsvp(session.sub, matchedRoute.params[0], validateRsvp(await readJsonBody(request))));
  }

  if (matchedRoute.name === 'admin-rsvp') {
    requireRole(session, ['admin']);
    return json(await airtable.setRsvp(matchedRoute.params[1], matchedRoute.params[0], validateRsvp(await readJsonBody(request))));
  }

  if (matchedRoute.name === 'member-vote') {
    requireRole(session, ['member']);
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
