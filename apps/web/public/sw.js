/* Terminalz PWA worker: cache only public static assets, never user/API data. */
const CACHE_NAME = "termag-static-v2";

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then(names =>
          Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)))
        ),
      self.clients.claim(),
    ])
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (url.pathname.startsWith("/api/") || request.mode === "navigate") {
    return;
  }

  const cacheable =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/manifest.webmanifest";
  if (!cacheable) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, copy)));
        }
        return response;
      })
      .catch(() => caches.match(request).then(response => response || Response.error()))
  );
});
