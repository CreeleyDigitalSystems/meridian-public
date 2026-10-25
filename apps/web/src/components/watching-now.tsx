import { useEffect, useState } from 'react';

/** Ephemeral per-tab identifier; never written to storage, a cookie or a third party. */
export function WatchingNow() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const session = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
    let alive = true, epoch = 0, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    const send = async (active: boolean) => {
      const generation = ++epoch;
      clearTimeout(timer); controller?.abort(); const current = new AbortController(); controller = current;
      const timeout = setTimeout(() => current.abort(), 5_000);
      try {
        const response = await fetch('/presence', {
          method: 'POST', credentials: 'omit', cache: 'no-store', keepalive: !active,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session, active }), signal: current.signal
        });
        if (!response.ok) throw new Error('unavailable');
        const raw = await response.text();
        if (raw.length > 64) throw new Error('unavailable');
        const data: unknown = JSON.parse(raw);
        if (!data || typeof data !== 'object' || Object.keys(data).join(',') !== 'activeSessions' || !Number.isSafeInteger((data as {activeSessions: number}).activeSessions) || (data as {activeSessions: number}).activeSessions < 0 || (data as {activeSessions: number}).activeSessions > 2_000) throw new Error('unavailable');
        if (alive && generation === epoch) setCount(active ? (data as {activeSessions: number}).activeSessions : null);
      } catch {
        if (alive && generation === epoch) setCount(null);
      } finally {
        clearTimeout(timeout);
        if (alive && generation === epoch && document.visibilityState === 'visible') timer = setTimeout(() => void send(true), 15_000);
      }
    };
    const visibility = () => { setCount(null); void send(document.visibilityState === 'visible'); };
    const reconnect = () => { if (document.visibilityState === 'visible') visibility(); };
    if (document.visibilityState === 'visible') void send(true);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('online', reconnect);
    return () => {
      alive = false; clearTimeout(timer); controller?.abort();
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', reconnect);
      void send(false);
    };
  }, []);
  return <span className="watching-now" title="Approximate active browser sessions, not a count of unique people.">Watching now <strong>{count === null ? 'Unavailable' : `${count} active ${count === 1 ? 'session' : 'sessions'}`}</strong></span>;
}
