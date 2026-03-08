/**
 * sw.js — FileShare Service Worker
 * ===================================
 * A service worker is a script the browser runs in the background,
 * separate from the web page. It intercepts network requests and can
 * serve cached responses — this is what makes a PWA installable and
 * able to launch without a network connection.
 *
 * Strategy used here: "Cache-first for shell, Network-first for API"
 *
 *   Shell files (HTML, CSS, JS, manifest):
 *     → Served from cache immediately (fast launch)
 *     → Updated in background when online
 *
 *   API routes (/api/*, /upload, /download/*, /view):
 *     → Always go to network (we need live data)
 *     → If network fails, return a friendly offline JSON
 *
 * PWA install lifecycle:
 *   1. Browser downloads and parses sw.js
 *   2. "install" fires → we cache the shell
 *   3. "activate" fires → we delete old caches
 *   4. "fetch" fires for every request the page makes
 */

const CACHE   = 'fileshare-v1';
const SHELL   = [
  '/',
  '/static/style.css',
  '/static/script.js',
  '/static/manifest.json',
  '/static/icon-192.png',
  '/static/icon-512.png',
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL))
  );
  // Activate immediately — don't wait for old tabs to close
  self.skipWaiting();
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  // Take control of existing pages immediately
  self.clients.claim();
});

// ── Fetch: route requests ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // SSE streams must never be cached — they are infinite
  if (url.pathname === '/api/chat/stream') return;

  // API and dynamic routes: network-first
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/upload') ||
    url.pathname.startsWith('/download/') ||
    url.pathname.startsWith('/view') ||
    url.pathname.startsWith('/fs-download') ||
    url.pathname.startsWith('/file/')
  ) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Shell: cache-first, update in background (stale-while-revalidate)
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(event.request);
      const networkFetch = fetch(event.request).then(response => {
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      }).catch(() => null);

      return cached || networkFetch;
    })
  );
});
