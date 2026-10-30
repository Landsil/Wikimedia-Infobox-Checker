// Service worker for the Headshots app.
//
// Its scope is this folder, because that is where the file sits and GitHub Pages
// cannot send the header that would widen it. That is deliberate: the other
// pages on the site are never intercepted or cached by this worker.
//
// Bump CACHE whenever the shipped files change, so an installed copy updates.

const CACHE = "headshots-v8";

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
  "build.js",
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

// Network first, cache only as the offline fallback.
//
// This was cache-first with a background refresh, which quietly cost a day of
// debugging: after a deploy the first load served the previous build and fetched
// the new one for *next* time, so fixes appeared not to have been made and a
// stale page was reported as a bug in code that had already been corrected. The
// app's own files are a few tens of kilobytes, so a round trip when online is
// nothing against being sure of what you are running.
//
// Offline use is unaffected: the fallback below serves the precached copy, and
// the big downloads (MediaPipe, pdf.js) live in their own Cache Storage, not here.
self.addEventListener("fetch", event => {
  const req = event.request;
  // Only our own static files. Anything cross-origin — the Wikipedia look-up —
  // goes straight to the network and is never cached or inspected here.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && fresh.type === "basic") await cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      // ignoreSearch, because the pages load assets with ?v= cache-busting.
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === "navigate") {
        const shell = await cache.match("index.html", { ignoreSearch: true });
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
