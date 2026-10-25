interface ServiceWorkerNavigator {
  serviceWorker?: {
    register(url: string): Promise<unknown>;
    getRegistrations?(): Promise<readonly {
      scope: string;
      active?: {
        scriptURL: string;
      } | null;
      unregister(): Promise<boolean>;
    }[]>;
  };
}
/** Retire the former internal-world cache owner before any public network read. */
export async function registerProductionServiceWorker(production: boolean, target: ServiceWorkerNavigator, storage: Pick<CacheStorage, 'keys' | 'delete'> | undefined = globalThis.caches): Promise<void> {
  if (!production || !target.serviceWorker) return;
  try {
    const registrations = (await target.serviceWorker.getRegistrations?.()) ?? [];
    for (const registration of registrations) if (new URL(registration.scope).pathname === '/' && !registration.active?.scriptURL.endsWith('/sw.js?public=v3')) await registration.unregister();
    const roots = registrations.filter(registration => new URL(registration.scope).pathname === '/').map(registration => registration.scope);
    if (storage) for (const key of await storage.keys()) if (key.startsWith('meridian') || key.startsWith('workbox-precache-') && roots.some(scope => key.endsWith(scope))) await storage.delete(key);
    await target.serviceWorker.register('/sw.js?public=v3');
  } catch {/* current public validation remains mandatory even when retirement APIs fail */}
}
