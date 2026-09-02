import assert from 'node:assert/strict';
import test from 'node:test';

import { issueSession, requireRole, verifySession } from '../../worker/src/auth.js';

const SECRET = 'fixture-session-secret-32-characters';
const OTHER_SECRET = 'other-session-secret-32-characters';

const encoder = new TextEncoder();

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

async function buildToken(payload, secret = SECRET) {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = toBase64Url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`));

  return `${header}.${body}.${Buffer.from(signature).toString('base64url')}`;
}

test('a valid member session round-trips with a twelve-hour expiration', async () => {
  const token = await issueSession({ sub: 'rec_fixture', role: 'member' }, SECRET, 1000);

  assert.deepEqual(await verifySession(token, SECRET, 1001), {
    sub: 'rec_fixture',
    role: 'member',
    iat: 1000,
    exp: 44200
  });
});

test('editing a signed member payload cannot promote it to administrator', async () => {
  const token = await issueSession({ sub: 'rec_fixture', role: 'member' }, SECRET, 1000);
  const [header, , signature] = token.split('.');
  const alteredPayload = toBase64Url(JSON.stringify({
    sub: 'rec_fixture',
    role: 'admin',
    iat: 1000,
    exp: 44200
  }));

  await assert.rejects(
    () => verifySession(`${header}.${alteredPayload}.${signature}`, SECRET, 1001),
    /invalid session signature/
  );
});

test('a session signed with a different secret is rejected', async () => {
  const token = await issueSession({ sub: 'rec_fixture', role: 'member' }, SECRET, 1000);

  await assert.rejects(() => verifySession(token, OTHER_SECRET, 1001), /invalid session signature/);
});

test('a session is rejected at its expiration boundary', async () => {
  const token = await issueSession({ sub: 'rec_fixture', role: 'member' }, SECRET, 1000);

  await assert.rejects(() => verifySession(token, SECRET, 44200), /session expired/);
});

test('signed sessions with invalid identity claims are rejected', async () => {
  const invalidClaims = [
    { role: 'member', iat: 1000, exp: 44200 },
    { sub: 'rec_fixture', role: 'owner', iat: 1000, exp: 44200 },
    { sub: '', role: 'member', iat: 1000, exp: 44200 },
    { sub: 'rec_fixture', role: 'member', iat: '1000', exp: 44200 }
  ];

  for (const claims of invalidClaims) {
    const token = await buildToken(claims);
    await assert.rejects(() => verifySession(token, SECRET, 1001), /invalid session claims/);
  }
});

test('oversized tokens are rejected before decoding', async () => {
  await assert.rejects(() => verifySession('a'.repeat(4097), SECRET, 1000), /invalid session token/);
});

test('role guards admit only an explicitly allowed role', () => {
  const guest = { sub: 'guest', role: 'guest', iat: 1000, exp: 44200 };
  const member = { sub: 'rec_fixture', role: 'member', iat: 1000, exp: 44200 };

  assert.equal(requireRole(member, ['member', 'admin']), member);
  assert.throws(() => requireRole(guest, ['member', 'admin']), /forbidden/);
  assert.throws(() => requireRole(member, ['admin']), /forbidden/);
});
