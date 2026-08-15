import { version as appVersion } from '../package.json';

// export default null
declare let self: ServiceWorkerGlobalScope;

// The cache name has to change whenever the build does, or the old cache is
// never evicted and the app is pinned to whatever was deployed first. The
// package version is not enough: it stays the same across deploys, so it used
// to serve stale files indefinitely. __BUILD_ID__ is injected per build.
const cacheName = `volulab-v${appVersion}-${__BUILD_ID__}`;

const cacheUrls = [
    './',
    './index.css',
    './index.html',
    './index.js',
    './manifest.json',
    './static/icons/logo.png',
    './static/images/screenshot-narrow.jpg',
    './static/images/screenshot-wide.jpg',
    './static/lib/webp/webp.mjs',
    './static/lib/webp/webp.wasm',
    './static/locales/de.json',
    './static/locales/en.json',
    './static/locales/fr.json',
    './static/locales/ja.json',
    './static/locales/ko.json',
    './static/locales/zh-CN.json'
];

self.addEventListener('install', (event) => {
    console.log(`installing ${cacheName}`);

    event.waitUntil(
        // the promise has to be returned, or install resolves before the
        // cache is populated
        caches.open(cacheName)
        .then(cache => cache.addAll(cacheUrls))
        // take over from the previous worker instead of waiting for every tab
        // holding the old version to close
        .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    console.log(`activating ${cacheName}`);

    event.waitUntil(
        caches.keys()
        .then(names => Promise.all(
            names.filter(name => name !== cacheName).map(name => caches.delete(name))
        ))
        // drive already-open pages with the new worker
        .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Navigations go to the network first so a deploy is visible on the next
    // load rather than after the cache happens to be evicted. The cache is
    // still there as the offline fallback.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
            .then((response) => {
                const copy = response.clone();
                caches.open(cacheName).then(cache => cache.put(request, copy));
                return response;
            })
            .catch(() => caches.match(request).then(cached => cached ?? caches.match('./index.html')))
        );
        return;
    }

    // Everything else is cache-first: those URLs are versioned by the cache
    // name, so a new build repopulates them rather than reusing stale copies.
    event.respondWith(
        caches.match(request).then(response => response ?? fetch(request))
    );
});
