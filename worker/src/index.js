import { createAirtable } from './airtable.js';
import { createCachedAirtable } from './cache.js';
import { ApiError } from './errors.js';
import { routeRequest } from './routes.js';

const PUBLIC_MESSAGES = {
  SESSION_INVALID: 'Please sign in again.',
  SESSION_EXPIRED: 'Please sign in again.',
  FORBIDDEN: 'That action is not allowed.'
};

const REQUIRED_AUTH_BINDINGS = ['SESSION_SECRET', 'GUEST_LOGIN', 'ADMIN_LOGIN'];

function requireAuthBindings(env) {
  for (const name of REQUIRED_AUTH_BINDINGS) {
    if (
      typeof env[name] !== 'string'
      || env[name] === ''
      || (name === 'SESSION_SECRET' && env[name].length < 32)
    ) {
      throw new ApiError(500, 'CONFIGURATION_ERROR', 'The app authentication service is not configured.');
    }
  }
}

function allowedOrigins(env) {
  return new Set((env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean));
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'DELETE, GET, PATCH, POST, PUT, OPTIONS',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged
  });
}

function errorResponse(error, requestId, origin) {
  const known = error instanceof ApiError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const message = PUBLIC_MESSAGES[code] ?? (known ? error.message : 'The request could not be completed.');

  return new Response(JSON.stringify({ error: { code, message, requestId } }), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin)
    }
  });
}

export async function handleRequest(request, env, ctx, deps = {}) {
  const requestId = (deps.randomUUID ?? (() => crypto.randomUUID()))();
  const origin = request.headers.get('Origin');
  const approvedOrigin = !origin || allowedOrigins(env).has(origin) ? origin : null;

  if (origin && !approvedOrigin) {
    return errorResponse(
      new ApiError(403, 'ORIGIN_FORBIDDEN', 'This app origin is not allowed.'),
      requestId,
      null
    );
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(approvedOrigin) });
  }

  try {
    requireAuthBindings(env);
    const rawAirtable = deps.airtable ?? createAirtable(env);
    const cache = deps.cache === undefined ? globalThis.caches?.default : deps.cache;
    const airtable = createCachedAirtable(rawAirtable, cache, Date.now, env.AIRTABLE_BASE_ID);
    const nowSeconds = (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
    const response = await routeRequest(request, env, airtable, nowSeconds);
    return withHeaders(response, corsHeaders(approvedOrigin));
  } catch (error) {
    return errorResponse(error, requestId, approvedOrigin);
  }
}

export default {
  fetch: handleRequest
};
