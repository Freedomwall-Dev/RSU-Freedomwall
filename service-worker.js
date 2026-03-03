const CACHE_NAME = "rsu-freedomwall-cache-v1";
const urlsToCache = [
  "/",
  "/index.html",
  "/about.html",
  "/contact.html",
  "/admin.html",
  "/css/styles.css",
  "/js/script.js",
  "/images/android-chrome-192x192.png",
  "/images/android-chrome-512x512.png",
  "/images/favicon-32x32.png",
  "/images/favicon-16x16.png",
  "/images/apple-touch-icon.png"
];

// Install Service Worker
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache);
    })
  );
});

// Fetch from Cache
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
