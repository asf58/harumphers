import assert from 'node:assert/strict';
import test from 'node:test';

import { createFixtureAirtable, FIXTURE_LOGIN } from '../fixtures/worker-data.mjs';
import { createFixtureServer } from '../fixtures/app-server.mjs';

test('fixture data is deterministic, synthetic, and exercises long mobile content', async () => {
  const first = createFixtureAirtable();
  const second = createFixtureAirtable();

  assert.deepEqual(await first.getDirectory('guest'), await second.getDirectory('guest'));
  const directory = await first.getDirectory('admin');
  assert.ok(directory.records.length >= 3);
  assert.ok(directory.records.some(record => record.fields['FULL NAME'].length > 30));
  assert.ok(directory.records.some(record => record.fields['E-MAIL ADDRESS'].length > 35));
  assert.equal(JSON.stringify(directory).includes('Fixture'), true);
});

test('the local model serves static pages and routes API calls through the real Worker handler', async t => {
  const model = await createFixtureServer({ host: '127.0.0.1', port: 0 });
  t.after(() => model.close());

  const page = await fetch(`${model.origin}/index.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(`data-api-origin="${model.origin.replaceAll('.', '\\.')}`));

  const login = await fetch(`${model.origin}/api/login/member`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: model.origin },
    body: JSON.stringify({ memberNumber: FIXTURE_LOGIN.memberNumber })
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();

  const directory = await fetch(`${model.origin}/api/directory`, {
    headers: { Authorization: `Bearer ${token}`, Origin: model.origin }
  });
  assert.equal(directory.status, 200);
  assert.ok((await directory.json()).records.length >= 3);
});

test('fixture mode never requires or reads an Airtable token', async () => {
  let readCount = 0;
  const env = new Proxy({}, {
    get(target, property) {
      if (property === 'AIRTABLE_TOKEN') readCount += 1;
      return target[property];
    }
  });
  const fixture = createFixtureAirtable(env);

  await fixture.getDirectory('guest');
  await fixture.getEventsBootstrap('guest');
  assert.equal(readCount, 0);
});
