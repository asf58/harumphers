const FRESH_MS = 15 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const CACHE_ORIGIN = 'https://cache.harumphers.invalid';
const ROLES = ['guest', 'member', 'admin'];
const RESOURCES = ['directory', 'events'];

const WRITE_METHODS = new Set([
  'addEventPhoto',
  'approveMemberRequest',
  'clearEventPhoto',
  'createEvent',
  'deletePhoto',
  'rejectMemberRequest',
  'saveAttendance',
  'setRsvp',
  'setVote',
  'submitMemberRequest',
  'updateEvent',
  'updateMember',
  'updateMemberProfile',
  'updatePhotoCaption',
  'uploadEventPhoto',
  'uploadMemberPhoto'
]);

function cacheRequest(resource, role, namespace) {
  return new Request(`${CACHE_ORIGIN}/v2/${encodeURIComponent(namespace)}/${resource}/${role}`);
}

async function clearNamedCaches(cache, namespace) {
  if (!cache) return;
  await Promise.all(RESOURCES.flatMap(resource => (
    ROLES.map(role => cache.delete(cacheRequest(resource, role, namespace)))
  )));
}

async function decodeCached(response) {
  if (!response) return null;
  const cachedAt = Number(response.headers.get('X-Harumphers-Cached-At'));
  if (!Number.isFinite(cachedAt)) return null;
  try {
    return { cachedAt, value: await response.json() };
  } catch {
    return null;
  }
}

async function store(cache, request, value, now) {
  if (!cache) return;
  await cache.put(request, new Response(JSON.stringify(value), {
    headers: {
      'Cache-Control': 'max-age=86400',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Harumphers-Cached-At': String(now)
    }
  }));
}

export function createCachedAirtable(airtable, cache, nowMs = () => Date.now(), namespace = 'default') {
  async function read(resource, role, loader) {
    if (!cache) return loader();
    const request = cacheRequest(resource, role, namespace);
    const cached = await decodeCached(await cache.match(request));
    const now = nowMs();
    const age = cached ? now - cached.cachedAt : Number.POSITIVE_INFINITY;
    if (cached && age >= 0 && age < FRESH_MS) return cached.value;

    try {
      const value = await loader();
      await store(cache, request, value, now);
      return value;
    } catch (error) {
      if (cached && age >= 0 && age <= STALE_MS) return cached.value;
      if (cached) await cache.delete(request);
      throw error;
    }
  }

  return new Proxy(airtable, {
    get(target, property, receiver) {
      if (property === 'getDirectory') {
        return role => read('directory', role, () => target.getDirectory(role));
      }
      if (property === 'getEventsBootstrap') {
        return role => read('events', role, () => target.getEventsBootstrap(role));
      }
      if (property === 'refreshCaches') {
        return async () => {
          await clearNamedCaches(cache, namespace);
          return { refreshed: true };
        };
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof property === 'string' && WRITE_METHODS.has(property) && typeof value === 'function') {
        return async (...args) => {
          const result = await value.apply(target, args);
          await clearNamedCaches(cache, namespace);
          return result;
        };
      }
      return value;
    }
  });
}
