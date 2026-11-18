// Minimal service worker: makes belay installable as an app and shows a friendly page while
// the server is down. Everything else goes straight to the network, nothing is cached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    `<!doctype html><meta charset="utf-8"><title>belay</title><meta http-equiv="refresh" content="3">
<style>body{font:15px system-ui;background:#0f1115;color:#d8dee9;display:grid;place-items:center;height:100vh;margin:0}p{text-align:center;color:#9aa4b5}b{color:#4c8dff}</style>
<p><b>belay</b><br><br>The server is not reachable. Retrying every few seconds…</p>`,
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
