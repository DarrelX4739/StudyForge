/* StudyForge service worker — makes the app installable and usable offline.
 *
 * Strategy:
 *   • HTML and versioned assets: network first, cache as a fallback, so a new
 *     deploy is picked up immediately when the user is online.
 *   • Everything else same-origin: cache first after the first visit.
 *   • Never touch API calls (different origins, or /api) — they must go straight
 *     to the network.
 */
const CACHE = "studyforge-v2026-10-23a";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./src/store.js",
  "./src/local.js",
  "./src/markdown.js",
  "./src/ocr.js",
  "./src/ai.js",
  "./src/jobs.js",
  "./src/ui.js",
  "./src/main.js",
  "./arch/config.json",
  "./arch/init.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll fails the whole install if one file 404s, so add them one by one.
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => undefined),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // AI providers and the relay
  if (url.pathname.includes("/api/")) return;

  const isDocument =
    request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html");

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (isDocument) {
        try {
          const fresh = await fetch(request);
          cache.put(request, fresh.clone());
          return fresh;
        } catch (error) {
          return (
            (await cache.match(request)) ||
            (await cache.match("./index.html")) ||
            (await cache.match("./")) ||
            new Response("StudyForge is offline and this page is not cached yet.", {
              status: 503,
              headers: { "content-type": "text/plain" },
            })
          );
        }
      }

      const cached = await cache.match(request);
      if (cached) {
        // Refresh in the background so the next visit has the newest file.
        fetch(request)
          .then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
          })
          .catch(() => undefined);
        return cached;
      }

      try {
        const response = await fetch(request);
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      } catch (error) {
        return new Response("", { status: 504 });
      }
    })(),
  );
});
