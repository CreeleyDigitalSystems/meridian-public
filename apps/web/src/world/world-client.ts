import { PublicEventSchema, type PublicEvent, type PublicSnapshot } from '@meridian/world-schema/public-world';
import { validateCurrentPublicSnapshot } from './public-world.js';
export interface EventSubscriptionHandlers {
  onEvent(event: PublicEvent): void;
  onError(): void;
}
export interface WorldClient {
  fetchSnapshot(): Promise<PublicSnapshot>;
  subscribe(handlers: EventSubscriptionHandlers, afterCursor?: number): () => void;
}
interface EventSourceLike {
  close(): void;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
}
export interface WorldClientOptions {
  fetch: typeof globalThis.fetch;
  createEventSource(url: string): EventSourceLike;
}
export function createWorldClient(options: WorldClientOptions): WorldClient {
  const fetchSnapshotResponse = options.fetch;
  return {
    async fetchSnapshot() {
      const response = await fetchSnapshotResponse('/world', {
        method: 'GET',
        headers: {
          accept: 'application/json'
        },
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('public world unavailable');
      return validateCurrentPublicSnapshot(await response.json());
    },
    subscribe(handlers, afterCursor = 0) {
      const source = options.createEventSource(`/events?after=${afterCursor}`);
      let closed = false;
      const fail = () => {
        if (!closed) {
          closed = true;
          source.close();
          handlers.onError();
        }
      };
      source.onmessage = message => {
        if (closed) return;
        try {
          const event = PublicEventSchema.parse(JSON.parse(message.data));
          if (String(event.cursor) !== message.lastEventId) throw new Error('cursor mismatch');
          handlers.onEvent(event);
        } catch {
          fail();
        }
      };
      source.onerror = fail;
      return () => {
        closed = true;
        source.onmessage = null;
        source.onerror = null;
        source.close();
      };
    }
  };
}
