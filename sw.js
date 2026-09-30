// =============================================================
// E.F.I. service worker — makes switching pages instant and lets the
// app open with no signal.
//
//   App files (pages, scripts, styles, icons) → served from the cache at
//     once, refreshed in the background (stale-while-revalidate). When a
//     refresh finds a new version, every cached file is refreshed together
//     (so a page never runs against half-updated scripts) and open pages
//     are told, which shows a small "updated" toast.
//   supabase-js (pinned version) + the font → cache-first; they never change.
//   /api/config → stale-while-revalidate (public values only).
//   Everything else — /api/*, Supabase, Google, Gemini — is never cached.
//
// Registered by topbar.js. Served with Cache-Control: no-cache (vercel.json)
// so a new sw.js is picked up on the next visit.
// =============================================================
const CACHE = 'efi-v1'; // bump only to throw away every cached file at once
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js';
const SHELL = [
  'index.html', 'calendar.html', 'health.html', 'gym.html', 'finance.html', 'main.html', 'mealprep.html', 'privacy.html',
  'efi-auth.js', 'efi-core.js', 'efi-google.js', 'efi-data.js', 'efi-agent.js', 'energy.js',
  'sync.js', 'topbar.js', 'applehealth.js', 'hevy.js', 'wallet.js', 'efi-theme.css',
  'manifest.webmanifest', 'icons/efi-180.png', 'icons/efi-192.png', 'icons/efi-512.png',
  'api/config',
];
const IMMUTABLE_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing file must not abort the whole install.
    await Promise.all(SHELL.concat(SUPABASE_JS).map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Pages are cached without their query (?google=connected, ?q=…).
function keyFor(req) {
  const u = new URL(req.url);
  if (u.origin === self.location.origin) {
    u.search = ''; u.hash = '';
    if (u.pathname === '/') u.pathname = '/index.html';
    return u.toString();
  }
  return req.url;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.indexOf('/api/') === 0 && url.pathname !== '/api/config') return;
    event.respondWith(staleWhileRevalidate(event, req));
    return;
  }
  if (IMMUTABLE_HOSTS.indexOf(url.hostname) !== -1) event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE);
  const key = keyFor(req);
  const hit = await cache.match(key);
  // Keep a copy to compare against: `hit` itself goes to the page, and a
  // consumed body can't be cloned later.
  const before = hit ? hit.clone() : null;
  const refresh = (async () => {
    try {
      // By URL: a navigation Request can't be re-fetched with options.
      const res = await fetch(key, { cache: 'no-cache', credentials: 'same-origin' });
      if (!res.ok || res.type !== 'basic' || res.redirected) return res;
      const changed = before ? await differs(before, res.clone()) : false;
      await cache.put(key, res.clone());
      if (changed) scheduleUpdate();
      return res;
    } catch (e) { return null; }
  })();
  if (hit) { event.waitUntil(refresh); return hit; }
  const res = await refresh;
  if (res) return res;
  // Offline and never cached: open the home screen rather than an error page.
  if (req.mode === 'navigate') { const home = await cache.match(keyFor(new Request('/index.html'))); if (home) return home; }
  return Response.error();
}

async function differs(a, b) {
  const ea = a.headers.get('etag'), eb = b.headers.get('etag');
  if (ea && eb) return ea !== eb;
  try { return (await a.text()) !== (await b.text()); } catch (e) { return false; }
}

// A new version is live: refresh every cached app file in one go, then tell
// open pages. Debounced — one deploy touches many files.
let updateTimer = null;
function scheduleUpdate() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    const cache = await caches.open(CACHE);
    const own = (await cache.keys()).map((r) => r.url).filter((u) => new URL(u).origin === self.location.origin);
    await Promise.all(own.map(async (u) => {
      try { const res = await fetch(u, { cache: 'no-cache' }); if (res.ok && !res.redirected) await cache.put(u, res); } catch (e) {}
    }));
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'efi-updated' });
  }, 1500);
}
