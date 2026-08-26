import assert from 'node:assert/strict';
import test from 'node:test';

import { createCachedAirtable } from '../../worker/src/cache.js';

function memoryCache() {
  const values = new Map();
  return {
    values,
    async delete(request) {
      return values.delete(request.url);
    },
    async match(request) {
      return values.get(request.url)?.clone();
    },
    async put(request, response) {
      values.set(request.url, response.clone());
    }
  };
}

function fakeAirtable() {
  const calls = [];
  let failReads = false;
  return {
    calls,
    set failReads(value) { failReads = value; },
    async getDirectory(role) {
      calls.push(['getDirectory', role]);
      if (failReads) throw new Error('fixture upstream failure');
      return { records: [{ role, generation: calls.length }] };
    },
    async getEventsBootstrap(role) {
      calls.push(['getEventsBootstrap', role]);
      if (failReads) throw new Error('fixture upstream failure');
      return { events: [{ role, generation: calls.length }] };
    },
    async updateMemberProfile(recordId, value) {
      calls.push(['updateMemberProfile', recordId, value]);
      return { id: recordId };
    }
  };
}

test('named role-aware reads stay fresh for twenty-four hours', async () => {
  const cache = memoryCache();
  const airtable = fakeAirtable();
  let now = 1_000_000;
  const cached = createCachedAirtable(airtable, cache, () => now);

  const first = await cached.getDirectory('guest');
  now += (24 * 60 * 60 * 1000) - 1;
  const second = await cached.getDirectory('guest');
  const admin = await cached.getDirectory('admin');

  assert.deepEqual(second, first);
  assert.equal(admin.records[0].role, 'admin');
  assert.deepEqual(airtable.calls, [['getDirectory', 'guest'], ['getDirectory', 'admin']]);
  assert.equal(cache.values.size, 2);
});

test('a stale read is used only when refresh fails and expires after seven days', async () => {
  const cache = memoryCache();
  const airtable = fakeAirtable();
  let now = 1_000_000;
  const cached = createCachedAirtable(airtable, cache, () => now);
  const first = await cached.getEventsBootstrap('member');

  now += (24 * 60 * 60 * 1000) + 1;
  airtable.failReads = true;
  assert.deepEqual(await cached.getEventsBootstrap('member'), first);

  now += 6 * 24 * 60 * 60 * 1000;
  await assert.rejects(() => cached.getEventsBootstrap('member'), /fixture upstream failure/);
});

test('a successful write awaits invalidation of every named read cache', async () => {
  const cache = memoryCache();
  const airtable = fakeAirtable();
  const cached = createCachedAirtable(airtable, cache, () => 1_000_000);
  await Promise.all([
    cached.getDirectory('guest'),
    cached.getDirectory('admin'),
    cached.getEventsBootstrap('member'),
    cached.getEventsBootstrap('admin')
  ]);
  assert.equal(cache.values.size, 4);

  await cached.updateMemberProfile('recFixtureMember1', { name: 'Changed' });

  assert.equal(cache.values.size, 0);
  assert.deepEqual(airtable.calls.at(-1), [
    'updateMemberProfile', 'recFixtureMember1', { name: 'Changed' }
  ]);
});

test('the explicit refresh operation clears named caches without reaching Airtable', async () => {
  const cache = memoryCache();
  const airtable = fakeAirtable();
  const cached = createCachedAirtable(airtable, cache, () => 1_000_000);
  await cached.getDirectory('guest');

  assert.deepEqual(await cached.refreshCaches(), { refreshed: true });
  assert.equal(cache.values.size, 0);
  assert.deepEqual(airtable.calls, [['getDirectory', 'guest']]);
});
