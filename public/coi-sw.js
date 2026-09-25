// Service worker that adds the cross-origin isolation headers (COOP/COEP) to
// every response, for hosts that don't send them (the static Apache deploy).
// The negamax engine needs isolation for its shared-memory parallel search, and
// onnxruntime uses it for multi-threaded WASM. index.html registers this and
// reloads once so the page is served through it. With the headers already set
// (e.g. `ng serve`), index.html never registers it.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const request = event.request;
  // Chrome throws on these ("only-if-cached" must be same-origin); leave them be.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  event.respondWith(
    fetch(request).then(response => {
      if (response.status === 0) return response; // opaque: headers can't be changed
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );
});
