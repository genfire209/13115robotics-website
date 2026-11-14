// The old Task Tracker web app is retired. A browser that installed its
// offline copy fetches this file on its next visit: it removes the cached
// app and itself, then reloads open pages so they show the "moved" page.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
