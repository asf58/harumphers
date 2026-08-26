import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildStatic } from '../../scripts/build-static.mjs';
import { readSource } from '../helpers/read-source.mjs';

test('staging build replaces every production API origin without changing source pages', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'harumphers-staging-'));
  const outputDirectory = path.join(temporaryRoot, 'site');
  const stagingOrigin = 'https://harumphers-api-staging.example.test';
  try {
    await buildStatic({ apiOrigin: stagingOrigin, outputDirectory });
    for (const page of ['index.html', 'directory.html', 'events.html']) {
      const built = await readFile(path.join(outputDirectory, page), 'utf8');
      assert.equal(built.includes(`data-api-origin="${stagingOrigin}"`), true, page);
      assert.equal(built.includes('harumphers-api.adamsfeuer.workers.dev'), false, page);
    }
    assert.equal((await stat(path.join(outputDirectory, 'assets', 'harumphers-client.js'))).isFile(), true);
    await assert.rejects(
      () => buildStatic({ apiOrigin: 'http://not-secure.example.test', outputDirectory }),
      /HTTPS/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('Wrangler declares separate staging and no-cost abuse-control bindings', async () => {
  const source = await readSource('worker/wrangler.toml');
  assert.match(source, /\[env\.staging\]/);
  assert.match(source, /name = "harumphers-api-staging"/);
  assert.match(source, /name = "AUTH_RATE_LIMITER"/);
  assert.match(source, /name = "MEMBER_REQUEST_RATE_LIMITER"/);
});
