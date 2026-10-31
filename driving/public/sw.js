'use strict';
// Offline support for the phone steering wheel (controller.html) on GitHub Pages.
// Network-first: the network always wins when it answers, so updates show up on the next load;
// the cache is only the fallback when the phone has no internet (or the network hangs).
// Only the files below are handled. Every other request goes straight to the network.
var CACHE = 'cami-wheel-v1';
var FILES = ['controller.html', 'manifest.webmanifest', 'icon.svg'];
var NET_TIMEOUT_MS = 4000;

function abs(f) { return new URL(f, self.registration.scope).href; }

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(FILES.map(function (f) {
      return c.add(new Request(abs(f), { cache: 'no-cache' })).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('cami-wheel-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var key = null;
  FILES.forEach(function (f) { if (new URL(abs(f)).pathname === url.pathname) key = abs(f); });
  if (!key) return;
  e.respondWith(networkFirst(req, key));
});

function networkFirst(req, key) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    function done(r) { if (!settled) { settled = true; resolve(r); } }
    function fromCache() { return caches.match(key); }
    // Slow/hanging network (Wi-Fi without internet): answer from the cache after a while.
    var timer = setTimeout(function () { fromCache().then(function (r) { if (r) done(r); }); }, NET_TIMEOUT_MS);
    fetch(req).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok && res.type === 'basic' && !res.redirected) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { return c.put(key, copy); }).catch(function () {});
      }
      done(res);
    }, function (err) {
      clearTimeout(timer);
      fromCache().then(function (r) {
        if (r) done(r);
        else if (!settled) { settled = true; reject(err); }
      });
    });
  });
}
