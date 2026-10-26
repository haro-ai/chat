/*
 * PWA shell cache — offline = read-only history viewer (ARCH §4).
 * v0.1 scope: cache-first for the static shell; never cache WS or API.
 */
const CACHE = "haro-chat-v0";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(["/", "/manifest.webmanifest"])),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.protocol !== "https:") return;
  if (url.pathname.startsWith("/ws")) return;

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
});
