// Service worker for the Headshots app.
//
// Its scope is this folder, because that is where the file sits and GitHub Pages
// cannot send the header that would widen it. That is deliberate: the other
// pages on the site are never intercepted or cached by this worker.
//
// Bump CACHE whenever the shipped files change, so an installed copy updates.

const CACHE = "headshots-v5";

// Everything needed to open and use the app with no network. The shared
// stylesheet lives one level up; a worker may cache any URL its pages request,
// even outside its own scope.
const SHELL = [
  "./",
  "index.html",
  "check.html",
  "app.js",
  "app.css",
  "shoot.js",
  "exif.js",
  "identify.js",
  "db.js",
  "faces.js",
  "doc.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "../style.css",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One at a time, and never fail the whole install over one missing file.
    await Promise.all(SHELL.map(async url => {
      try { await cache.add(new Request(url, { cache: "reload" })); }
      catch (err) { console.warn("headshots sw: could not precache", url, err); }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys())
      if (key.startsWith("headshots-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  // Only our own static files. Anything cross-origin — the Wikipedia look-up —
  // goes straight to the network and is never cached or inspected here.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ignoreSearch, because the pages load assets with ?v= cache-busting.
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) {
      // Refresh in the background so the next launch is current.
      event.waitUntil((async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) await cache.put(req, fresh.clone());
        } catch (_) { /* offline: the cached copy stands */ }
      })());
      return hit;
    }
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === "basic") await cache.put(req, res.clone());
      return res;
    } catch (err) {
      // Offline and not cached: serve the app shell for a navigation, else fail.
      if (req.mode === "navigate") {
        const shell = await cache.match("index.html", { ignoreSearch: true });
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
