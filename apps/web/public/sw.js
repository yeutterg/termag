/*
 * Terminalz needs a service worker lifecycle for installed-app behavior, but
 * the terminal itself cannot work offline. Let the browser's HTTP cache own
 * immutable Next.js assets and remove caches left by older cache-first workers.
 */
const LEGACY_CACHE_PREFIXES = ["termag-", "terminalz-"];

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then(names =>
          Promise.all(
            names
              .filter(name => LEGACY_CACHE_PREFIXES.some(prefix => name.startsWith(prefix)))
              .map(name => caches.delete(name))
          )
        ),
      self.clients.claim(),
    ])
  );
});
