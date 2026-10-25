import { createContext, createElement, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { applyPublicEvent, type PublicSnapshot, type PublicFact, type PublicEvent, type PublicOperation } from '@meridian/world-schema/public-world';
import { groupPublicChanges } from './public-history.js';
import { createWorldClient, type WorldClient } from './world-client.js';
import { createIndexedDbProjectionStorage, createProjectionCache, type ProjectionCache } from './projection-cache.js';
import { publicCityView, validateCurrentPublicSnapshot, type PublicCityView } from './public-world.js';
export type WorldConnection = 'live' | 'reconnecting' | 'offline-stale';
export interface WorldRuntimeDependencies {
  client: WorldClient;
  cache: ProjectionCache;
  now(): Date;
}
export interface WorldRuntimeState {
  facts: readonly PublicFact[];
  /** Bounded presentation subset of already validated events, never a substitute replay ledger. */
  recentChanges: readonly {cursor: number; minute: number; operations: readonly PublicOperation[]}[];
  projection: PublicCityView | null;
  connection: WorldConnection;
  lastVerifiedAt: string | null;
}
const Context = createContext<WorldRuntimeState | null>(null);
export function WorldRuntimeProvider({
  children,
  dependencies
}: PropsWithChildren<{
  dependencies?: WorldRuntimeDependencies;
}>) {
  const runtime = useMemo(() => dependencies ?? {
    client: createWorldClient({
      fetch: globalThis.fetch,
      createEventSource: url => new EventSource(url)
    }),
    cache: createProjectionCache(createIndexedDbProjectionStorage()),
    now: () => new Date()
  }, [dependencies]);
  const [state, setState] = useState<WorldRuntimeState>({
    facts: [],
    recentChanges: [],
    projection: null,
    connection: 'reconnecting',
    lastVerifiedAt: null
  });
  useEffect(() => {
    let active = true,
      generation = 0,
      unsubscribe: (() => void) | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      snapshot: PublicSnapshot | null = null,
      queue = Promise.resolve(),
      attempt = 0,
      request: Promise<void> | undefined;
    const show = (connection: WorldConnection) => {
      if (active) setState(current => ({
        ...current,
        connection
      }));
    };
    const save = async (s: PublicSnapshot) => {
      try {
        await runtime.cache.save(s, runtime.now().toISOString());
      } catch {/* persistence never grants authority */}
    };
    const publish = (s: PublicSnapshot, event?: PublicEvent) => {
      snapshot = s;
      const highlights = event ? groupPublicChanges(event.operations).highlights : [];
      const outcomes = new Set(['trial.state','artifact.state','grant.state','method.state','design.state','assembly-job.state','transit.state','construction.state','project.state','venture.state']);
      const result = (op: PublicOperation) => op.op === 'put' && outcomes.has(op.fact.code);
      const operations = [...highlights.filter(result), ...highlights.filter(op => !result(op))].slice(0, 24);
      setState(current => ({
        facts: s.facts,
        recentChanges: event ? [...current.recentChanges.filter(e => e.cursor !== event.cursor), {cursor: event.cursor, minute: event.minute, operations}].slice(-12) : [],
        projection: publicCityView(s),
        connection: 'live',
        lastVerifiedAt: runtime.now().toISOString()
      }));
    };
    const retry = () => {
      show('offline-stale');
      if (active && timer === undefined) timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, Math.min(250 * 2 ** attempt++, 5000));
    };
    const refresh = (): Promise<void> => {
      if (!active) return Promise.resolve();
      if (request) return request;
      const epoch = ++generation;
      unsubscribe?.();
      if (timer) clearTimeout(timer);
      timer = undefined;
      show('reconnecting');
      request = (async () => {
        try {
          const fresh = await validateCurrentPublicSnapshot(await runtime.client.fetchSnapshot());
          if (!active || epoch !== generation) return;
          attempt = 0;
          publish(fresh);
          void save(fresh);
          unsubscribe = runtime.client.subscribe({
            onEvent(event) {
              queue = queue.then(async () => {
                if (!active || epoch !== generation || !snapshot) return;
                const next = await applyPublicEvent(snapshot, event);
                await validateCurrentPublicSnapshot(next);
                if (!active || epoch !== generation) return;
                publish(next, event);
                void save(next);
              }).catch(() => {
                if (active && epoch === generation) {
                  generation++;
                  unsubscribe?.();
                  retry();
                }
              });
            },
            onError() {
              if (active && epoch === generation) {
                generation++;
                unsubscribe?.();
                retry();
              }
            }
          }, fresh.cursor);
        } catch {
          if (active && epoch === generation) retry();
        } finally {
          request = undefined;
        }
      })();
      return request;
    };
    // Never display a prior-policy cache before a safe current network baseline.
    // Cache retirement runs independently: a slow old read cannot delay or overwrite the network.
    void runtime.cache.load().catch(() => null);
    void refresh();
    const online = () => {
      void refresh();
    };
    window.addEventListener('online', online);
    return () => {
      active = false;
      generation++;
      unsubscribe?.();
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', online);
    };
  }, [runtime]);
  return createElement(Context.Provider, {
    value: state
  }, children);
}
export function useWorld() {
  const value = useContext(Context);
  if (!value) throw new Error('useWorld requires provider');
  return value;
}
