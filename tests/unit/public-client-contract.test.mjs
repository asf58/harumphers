import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from '../helpers/read-source.mjs';

const publicPages = ['index.html', 'directory.html', 'events.html'];

test('a shared Worker authorization gate cannot ship in a public page', async () => {
  const sharedGatePattern = /X-Harumphers-Key|const\s+API_KEY\s*=/;

  for (const page of publicPages) {
    const source = await readSource(page);
    assert.equal(sharedGatePattern.test(source), false, `${page} exposes a shared Worker authorization gate`);
  }
});

test('a public page cannot address an arbitrary Airtable proxy path', async () => {
  const arbitraryProxyPattern = /\/v0\//;

  for (const page of publicPages) {
    const source = await readSource(page);
    assert.equal(arbitraryProxyPattern.test(source), false, `${page} addresses an arbitrary Airtable proxy path`);
  }
});

test('loading Directory or Events cannot invoke approved-change mutations', async () => {
  const autoApplyPattern = /applyApprovedChanges\s*\(\)/;

  for (const page of ['directory.html', 'events.html']) {
    const source = await readSource(page);
    assert.equal(autoApplyPattern.test(source), false, `${page} can invoke approved-change mutations during page load`);
  }
});
