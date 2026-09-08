import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from '../helpers/read-source.mjs';

test('the service worker caches only scope-relative app-shell resources', async () => {
  const source = await readSource('sw.js');

  assert.match(source, /const CACHE_NAME = 'harumphers-v38'/);
  assert.doesNotMatch(source, /['"]\/index\.html['"]/);
  assert.doesNotMatch(source, /['"]\/directory\.html['"]/);
  assert.match(source, /\.\/index\.html/);
  assert.match(source, /\.\/directory\.html/);
  assert.match(source, /\.\/assets\/harumphers-client\.js/);
  assert.match(source, /self\.skipWaiting\(\)/);
  assert.match(source, /self\.clients\.claim\(\)/);
});

test('every page declares the install manifest and safe-area viewport support', async () => {
  for (const page of ['index.html', 'directory.html', 'events.html']) {
    const source = await readSource(page);
    assert.match(source, /rel="manifest" href="manifest\.json"/, page);
    assert.match(source, /viewport-fit=cover/, page);
  }
});
