/*
 * PWA shell cache — offline = read-only history viewer (ARCH §4).
 *
 * v1 strategy:
 * - Navigations (index.html): NETWORK-FIRST with cache fallback. Cache-first
 *   here kept the old app shell alive forever (browsers only re-fetch sw.js
 *   when its bytes change, and cache-first never revalidated "/"), so deploys
 *   never reached clients. Network-first makes every deploy land on reload.
 * - Hashed /assets/*: cache-first — content-addressed, immutable by build.
 * - Never cache /ws or any non-GET.
 */
const CACHE = "haro-chat-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(["/", "/manifest.webmanifest"])),
  );
});

self.addEventListener("activate", (event) => {
  // Drop caches from previous versions (e.g. haro-chat-v0) and take control
  // of open tabs immediately so the updated shell lands without a second
  // reload dance.
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.protocol !== "https:") return;
  if (url.pathname.startsWith("/ws")) return;

  // Navigations (the app shell): try the network first so deploys propagate;
  // fall back to the cache when offline.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match("/"))),
    );
    return;
  }

  // Hashed build assets: immutable, cache-first is safe and fast.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Everything else (manifest, icons): stale-while-revalidate-ish — serve
  // cache when present, refresh in the background.
  event.respondWith(
    caches.match(event.request).then((hit) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit ?? network;
    }),
  );
});