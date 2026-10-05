// The service worker of the supplier cabinet (TASK-031, ARCHITECTURE 4.47).
// `sw/service-worker-plugin.ts` fills in the version and the files of the
// build; the result is served as /sw.js.
//
// - The shell (the page, its scripts, styles, fonts, icons) is kept at
//   installation, so the cabinet opens without a network: the page itself
//   says «Нет сети», never the browser.
// - Pages come from the network first (a few seconds at most), so an opening
//   with a network always gets the newest version; the cached shell only
//   stands in when there is none.
// - Files of the build have their hash in the name: the cached copy is the
//   right one forever. Anything else of the site goes to the network.
// - The API is another origin and is never touched: its answers are not
//   cached (TASK-031 doesn't keep any of them).
"use strict";

const VERSION = "__VERSION__";
const SHELL = "/index.html";
const FILES = ["__FILES__"];
const CACHE = `adclub-cabinet-${VERSION}`;
const NAVIGATION_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([SHELL, ...FILES]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("adclub-cabinet-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// A page asks whether its own script belongs to this version: if not, it
// was loaded before the update and offers «Обновить».
self.addEventListener("message", (event) => {
  const data = event.data;
  const port = event.ports && event.ports[0];
  if (!port || !data || data.type !== "has-file" || typeof data.path !== "string") return;
  port.postMessage(FILES.includes(data.path));
});

/** The network's answer, or nothing after a few seconds (a network that hangs). */
function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), NAVIGATION_TIMEOUT_MS);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fromNetwork(request).catch(() =>
        caches.match(SHELL, { cacheName: CACHE }).then((shell) => shell || Response.error()),
      ),
    );
    return;
  }

  if (FILES.includes(url.pathname)) {
    event.respondWith(
      caches.match(url.pathname, { cacheName: CACHE }).then((cached) => cached || fetch(request)),
    );
  }
});
