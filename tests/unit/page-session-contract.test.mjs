import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from '../helpers/read-source.mjs';

const pages = ['index.html', 'directory.html', 'events.html'];

test('every page loads the signed-session client before its inline application script', async () => {
  for (const page of pages) {
    const source = await readSource(page);
    const clientPosition = source.indexOf('src="assets/harumphers-client.js"');
    const inlinePosition = source.indexOf('<script>', clientPosition + 1);
    assert.notEqual(clientPosition, -1, `${page} does not load the signed-session client`);
    assert.equal(clientPosition < inlinePosition, true, `${page} loads the client after its application script`);
  }
});

test('page authorization never reads or writes a locally selected role', async () => {
  for (const page of pages) {
    const source = await readSource(page);
    assert.equal(/localStorage\.(?:getItem|setItem)\(['"]harumphers_auth['"]/.test(source), false, page);
    assert.equal(source.includes('Harumphers.getSession()'), true, `${page} does not restore its Worker session`);
  }
});

test('the login page delegates all three visible login flows to the signed-session client', async () => {
  const source = await readSource('index.html');
  for (const method of ['loginGuest', 'loginMember', 'loginAdmin']) {
    assert.equal(source.includes(`Harumphers.${method}(`), true, `index.html does not use ${method}`);
  }
});

test('directory administration cannot advertise a role change that member login does not honor', async () => {
  const source = await readSource('directory.html');
  assert.equal(source.includes('Make Admin'), false);
  assert.equal(source.includes('Remove Admin'), false);
  assert.equal(source.includes('toggleAdmin('), false);
  assert.equal(source.includes("f['IS ADMIN']"), false);
});
