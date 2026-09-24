// The phone shell. Caches the pages and scripts so the app opens offline; never caches
// /api or /media. Push: fetch her latest first text and show it; a tap opens the thread.
const CACHE = "avelie-shell-v2";
const SHELL = ["/", "/css/app.css", "/js/api.js", "/js/nav.js", "/js/chat.js", "/js/bubbles.js", "/js/call.js", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function cacheable(request, response) {
  if (!response || !response.ok || response.type !== "basic" || response.redirected) return false;
  try {
    return new URL(response.url).origin === self.location.origin && new URL(request.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (cacheable(request, response)) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const hit = await caches.match(request, { ignoreSearch: true });
        if (hit) return hit;
        if (request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});

function latestText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload.text || payload.body || payload.content;
  if (typeof direct === "string") return direct;
  const m = payload.message || payload.latest;
  if (m && typeof m === "object" && typeof m.content === "string") return m.content;
  return "";
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let body = "";
    try {
      const res = await fetch("/api/push/latest", { credentials: "include", cache: "no-store" });
      if (res.ok) body = latestText(await res.json());
    } catch {
      body = "";
    }
    if (!body && event.data) {
      try { body = event.data.text(); } catch { body = ""; }
    }
    await self.registration.showNotification("Avelie", {
      body: body.slice(0, 240),
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: "avelie-first",
      data: { url: "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
