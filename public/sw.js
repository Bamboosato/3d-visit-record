const SHELL_CACHE = 'visit3d-shell-v4';
const PREVIOUS_SHELL_CACHE = 'visit3d-shell-v3';
const MAX_SHELL_ENTRIES = 120;
const MAX_SHELL_BYTES = 40 * 1024 * 1024;
const PRECACHE_URLS = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon.svg', /*BUILD_ASSETS*/];
const queues = new Map();

self.addEventListener('message', (event) => {
  if (event.data?.type === 'VISIT3D_APPLY_UPDATE') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS.filter((u) => !u.includes('/*BUILD_ASSETS*/'))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith('visit3d-shell-') &&
                key !== SHELL_CACHE &&
                key !== PREVIOUS_SHELL_CACHE
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

const inventories = new Map();
async function inventory(name, cache) {
  if (!inventories.has(name)) {
    const pending = cache
      .keys()
      .then((keys) => new Map(keys.map((request) => [request.url, { request, size: undefined }])));
    inventories.set(name, pending);
    pending.catch(() => {
      if (inventories.get(name) === pending) inventories.delete(name);
    });
  }
  return inventories.get(name);
}

async function trimCache(cache, entries, maxItems, maxBytes, force = false) {
  let audited = 0;
  for (const entry of entries.values()) {
    if (entry.size !== undefined) continue;
    if (audited++ >= 4) break;
    const response = await cache.match(entry.request);
    const stored = response?.headers?.get('x-visit3d-bytes');
    entry.size = stored ? Number(stored) : response ? (await response.arrayBuffer()).byteLength : 0;
  }
  let bytes = [...entries.values()].reduce((sum, entry) => sum + (entry.size || 0), 0);
  const target = force ? Math.floor(entries.size * 0.8) : maxItems;
  for (const [key, entry] of entries) {
    if (entries.size <= target && bytes <= maxBytes * (force ? 0.8 : 1)) break;
    await cache.delete(entry.request);
    bytes -= entry.size || 0;
    entries.delete(key);
  }
}

function persist(name, request, response) {
  if (!response || response.status !== 200) return Promise.resolve();
  const task = (queues.get(name) || Promise.resolve())
    .then(async () => {
      const cache = await caches.open(name);
      const entries = await inventory(name, cache);
      const body = await response.arrayBuffer();
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      headers.set('x-visit3d-bytes', String(body.byteLength));
      const stored = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      try {
        await cache.put(request, stored.clone());
      } catch (error) {
        if (error?.name !== 'QuotaExceededError') throw error;
        await trimCache(cache, entries, MAX_SHELL_ENTRIES, MAX_SHELL_BYTES, true);
        await cache.put(request, stored.clone());
      }
      const key = typeof request === 'string' ? new URL(request, self.location.origin).href : request.url;
      entries.delete(key);
      entries.set(key, { request, size: body.byteLength });
      await trimCache(cache, entries, MAX_SHELL_ENTRIES, MAX_SHELL_BYTES);
    })
    .catch(() => {});
  queues.set(name, task);
  return task;
}

async function match(name, request) {
  try {
    return await (await caches.open(name)).match(request);
  } catch {
    return undefined;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/src/') || url.pathname.startsWith('/@') || url.pathname.startsWith('/node_modules/')) {
    return;
  }

  const key = request.mode === 'navigate' ? '/index.html' : request;
  const writes = [];
  const network = async () => {
    const response = await fetch(request, request.mode === 'navigate' ? { cache: 'no-store' } : undefined);
    writes.push(persist(SHELL_CACHE, key, response.clone()));
    return response;
  };

  const response = (async () => {
    const cached = (await match(SHELL_CACHE, key)) || (await match(PREVIOUS_SHELL_CACHE, key));
    try {
      return await network();
    } catch {
      return cached || Response.error();
    }
  })();

  event.respondWith(response);
  event.waitUntil(
    response
      .then(async () => {
        for (let i = 0; i < writes.length; i++) await writes[i];
      })
      .catch(() => {})
  );
});
