/** Upgrade worker: no response caches and no offline projection fallback. */
export const PUBLIC_RETIREMENT_WORKER = `
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('meridian') || key.startsWith('workbox-precache-') && key.endsWith(self.registration.scope)) await caches.delete(key);
  await self.clients.claim();
  for (const client of await self.clients.matchAll({type:'window',includeUncontrolled:true})) {
    // Navigation may wait for activation. It must not extend this activate event.
    if (new URL(client.url).origin === self.location.origin) void client.navigate(client.url).catch(() => {});
  }
})()));
`;
