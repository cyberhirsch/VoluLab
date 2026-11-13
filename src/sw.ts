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
    './static/lib/webp/webp.wasm',
    './static/locales/de.json',
    './static/locales/en.json',
    './static/locales/es.json',
    './static/locales/fr.json',
    './static/locales/ja.json',
    './static/locales/ko.json',
    './static/locales/pt-BR.json',
    './static/locales/ru.json',
    './static/locales/zh-CN.json'
];

// The trainer (Brush) and in-browser poses (colmap-wasm): large, and loaded
// only when used, but without them there is no training offline. Cached on
// a best-effort basis, so a missing or failed one never fails the install.
const optionalUrls = [
    './static/brush/pkg/brush_js.js',
    './static/brush/pkg/brush_js_bg.wasm',
    './static/colmap-wasm/dist/index.js',
    './static/colmap-wasm/dist/estimate.js',
    './static/colmap-wasm/dist/pairs.js',
    './static/colmap-wasm/dist/protocol.js',
    './static/colmap-wasm/dist/sift-matcher.js',
    './static/colmap-wasm/dist/types.js',
    './static/colmap-wasm/dist/colmap-files.js',
    './static/colmap-wasm/dist/worker.js',
    './static/colmap-wasm/wasm/colmap.mjs',
    './static/colmap-wasm/wasm/colmap.wasm'
];

self.addEventListener('install', (event) => {
    console.log(`installing ${cacheName}`);

    event.waitUntil(
        // the promise has to be returned, or install resolves before the
        // cache is populated
        caches.open(cacheName)
        .then(cache => cache.addAll(cacheUrls)
        .then(() => Promise.all(optionalUrls.map(url => cache.add(url).catch(() => {})))))
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

    // only the app's own files: the bridge on 127.0.0.1, uploads and other
    // origins go straight to the network
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
        return;
    }

    // Network first, for everything. The first load after a deploy is still
    // served by the previous worker; answering the new index.html from the
    // network but index.js, locales or the trainer from that worker's cache
    // ran new markup on old code. The cache is the offline fallback, and a
    // file is stored once per build (the cache is per build), not on every
    // load - the trainer's wasm is tens of megabytes.
    event.respondWith(
        fetch(request)
        .then((response) => {
            if (response.ok && response.type === 'basic') {
                const copy = response.clone();
                caches.open(cacheName)
                .then(cache => cache.match(request).then(cached => (cached ? undefined : cache.put(request, copy))))
                .catch(() => {});
            }
            return response;
        })
        .catch(() => caches.match(request).then((cached) => {
            if (cached) return cached;
            if (request.mode === 'navigate') return caches.match('./index.html');
            return Response.error();
        }))
    );
});
