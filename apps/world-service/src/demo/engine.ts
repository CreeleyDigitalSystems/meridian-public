import { createServer, type ServerResponse } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { advanceWorld, commissionTransit, createCityLife2State, enableFrontierAccess, migrateCivicProjects, migrateFrontier } from '@meridian/world-kernel';
import { appendLedger, GENESIS_HASH, type LedgerEntry } from '@meridian/world-ledger';
import { PublicDiscoverySchema, PublicHistorySchema, publicCanonicalJson, type PublicEvent, type WorldSnapshot } from '@meridian/world-schema';
import { WorldStore } from '../store/world-store.js';
import { PresenceRegistry, presenceOrigin, servePresence } from '../public-observer/presence.js';

const SEED = 'meridian-public-demo-v1';
const MARKER = '.meridian-synthetic.json';
const FORMAT = JSON.stringify({ version: 2, purpose: 'fictional-local-demo', seed: SEED,
  features: ['civic', 'frontier', 'frontier-access', 'transit'], wardrobe: false });
const DATABASE = 'synthetic.sqlite';
const HISTORY_MEDIA = 'application/vnd.meridian.city-ledger+json';
const HISTORY_HEADERS = ['x-meridian-history-before', 'x-meridian-history-limit'];

// Reuse the bounded positive-integer semantics of Meridian's public history route, without its private server imports.
function historyInteger(values: string[], maximum: number): number | undefined | null {
  if (!values.length) return undefined;
  const value = values[0];
  if (values.length !== 1 || value === undefined || value.length > 16 || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}
function headerValues(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** This local listener accepts only ordinary origin-form targets, never an absolute or alternate origin. */
export function parseLocalRequestTarget(target: string | undefined): URL | null {
  if (!target || target.length > 2048 || !target.startsWith('/') || target.startsWith('//')
      || /[\\\u0000-\u0020\u007f#]/.test(target)) return null;
  try {
    const url = new URL(target, 'http://127.0.0.1');
    return url.origin === 'http://127.0.0.1' ? url : null;
  } catch { return null; }
}

/** The only state accepted is this deliberately fictional demo; unknown files are never opened or reset. */
export function openSyntheticWorld(inputDirectory: string) {
  const directory = resolve(inputDirectory);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Synthetic directory must be a real directory');
  const marker = join(directory, MARKER);
  const files = readdirSync(directory);
  if (!files.length) writeFileSync(marker, FORMAT, { flag: 'wx', mode: 0o600 });
  if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() || readFileSync(marker, 'utf8') !== FORMAT
      || readdirSync(directory).some(name => ![MARKER, DATABASE, DATABASE + '-wal', DATABASE + '-shm'].includes(name))) {
    throw new Error('Refusing unmarked or unknown synthetic directory');
  }
  for (const name of readdirSync(directory)) {
    const file = lstatSync(join(directory, name));
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error('Refusing non-regular synthetic files');
  }
  const fresh = !existsSync(join(directory, DATABASE));
  const store = WorldStore.open(join(directory, DATABASE));
  let closed = false;
  let snapshot: WorldSnapshot;
  try {
    if (fresh) {
      const state = createCityLife2State(SEED, 24);
      // Fictional public characters only: no recovered biography, relationships or companion prompts.
      state.residents['resident-01']!.name = 'Sol';
      state.residents['resident-02']!.name = 'Luna';
      let current: WorldSnapshot = { snapshotVersion: 1, state, ledgerBaseSequence: 0, ledgerBaseHash: GENESIS_HASH };
      store.commitTransition(current, []);
      // These are real operator opening events, not earned construction, charted ground or free resident work.
      for (const migrate of [migrateCivicProjects, migrateFrontier, enableFrontierAccess, commissionTransit]) {
        const migration = migrate(current.state);
        if (!migration.event) throw new Error('Required synthetic opening unavailable');
        const entry = appendLedger(current.ledgerBaseHash, current.ledgerBaseSequence + 1, migration.event);
        current = { snapshotVersion: 1, state: migration.state, ledgerBaseSequence: entry.sequence, ledgerBaseHash: entry.hash };
        store.commitTransition(current, [entry]);
      }
    }
    snapshot = store.loadVerifiedWorld();
    if (snapshot.state.seed !== SEED || snapshot.state.engineVersion !== 'city-life-2'
        || Object.keys(snapshot.state.residents).length !== 24 || !snapshot.state.life?.frontierAccess
        || !snapshot.state.life.transit || snapshot.state.life.wardrobe !== undefined
        || store.loadLedgerSuffixAfter(snapshot.ledgerBaseSequence).length) throw new Error('Synthetic world identity or integrity refused');
    store.publicSnapshot(); // Canonical association must verify before any HTTP listener exists.
  } catch (error) { store.close(); throw error; }
  return {
    snapshot: () => structuredClone(snapshot),
    publicSnapshot: () => store.publicSnapshot(),
    publicEventsAfter: (cursor: number) => store.publicEventsAfter(cursor),
    publicEventPage: (query: { before?: number; limit: number }) => store.publicEventPage(query),
    advance(minutes: number): PublicEvent[] {
      if (closed || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) throw new Error('Invalid synthetic advance');
      const publicEvents: PublicEvent[] = [];
      for (let i = 0; i < minutes; i++) {
        const transition = advanceWorld(snapshot.state, { type: 'advance-clock', targetMinute: snapshot.state.canonicalMinute + 1 });
        let hash = snapshot.ledgerBaseHash;
        const entries: LedgerEntry[] = transition.events.map((event, index) => {
          const entry = appendLedger(hash, snapshot.ledgerBaseSequence + index + 1, event);
          hash = entry.hash;
          return entry;
        });
        const next: WorldSnapshot = { snapshotVersion: 1, state: transition.state,
          ledgerBaseSequence: entries.at(-1)!.sequence, ledgerBaseHash: hash };
        const publicEvent = store.commitTransition(next, entries);
        snapshot = next;
        if (publicEvent) publicEvents.push(publicEvent);
      }
      return publicEvents;
    },
    close() { if (!closed) { closed = true; store.close(); } }
  };
}

export async function startDemo(options: { directory: string; port?: number; tickMilliseconds?: number; viewerOrigin?: string }) {
  const tick = options.tickMilliseconds ?? 100;
  const port = options.port ?? 8787;
  if (!Number.isSafeInteger(tick) || tick < 10 || tick > 60000 || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local demo settings');
  const origin = presenceOrigin(options.viewerOrigin ?? 'http://127.0.0.1:5173');
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('Local viewer origin required');
  const presence = new PresenceRegistry();
  const world = openSyntheticWorld(options.directory);
  const clients = new Set<ServerResponse>();
  let failed = false;
  let closed = false;
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(publicCanonicalJson(body));
  };
  const send = (response: ServerResponse, event: PublicEvent) => {
    if (!response.write(`id: ${event.cursor}\ndata: ${publicCanonicalJson(event)}\n\n`)) { clients.delete(response); response.end(); }
  };
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    if (request.url === '/presence' && !failed && !closed) { void servePresence(request, response, presence, origin); return; }
    if (request.method !== 'GET') return json(response, 405, { status: 'read-only' });
    if ((request.url?.length ?? 0) > 2048 || failed || closed) return json(response, 503, { status: 'unavailable' });
    try {
      const url = parseLocalRequestTarget(request.url);
      if (!url) return json(response, 400, { status: 'invalid-target' });
      const history = request.headers.accept === HISTORY_MEDIA;
      const historyHeaders = Object.keys(request.headers).filter(name => name.startsWith('x-meridian-history-'));
      if (historyHeaders.some(name => !HISTORY_HEADERS.includes(name))
          || (history || historyHeaders.length > 0) && (url.pathname !== '/world' || url.searchParams.size > 0 || !history)) {
        return json(response, 400, { status: 'invalid-history-query' });
      }
      if (url.pathname === '/health') return json(response, 200, { status: 'running', mode: 'fictional-local-demo' });
      if (url.pathname === '/world') {
        if (request.headers.accept !== undefined && !['*/*', 'application/json', HISTORY_MEDIA].includes(request.headers.accept)) {
          return json(response, 406, { status: 'unsupported-media' });
        }
        const snapshot = world.publicSnapshot();
        const view = history ? 'city-ledger' : url.searchParams.get('view');
        if (!view) return json(response, 200, snapshot);
        if (view === 'city-ledger') {
          const limit = historyInteger(history ? headerValues(request.headers['x-meridian-history-limit']) : url.searchParams.getAll('limit'), 100);
          const before = historyInteger(history ? headerValues(request.headers['x-meridian-history-before']) : url.searchParams.getAll('before'), Number.MAX_SAFE_INTEGER);
          if (limit === null || before === null) return json(response, 400, { status: 'invalid-history-query' });
          const page = world.publicEventPage({ limit: limit ?? 20, ...(before === undefined ? {} : { before }) });
          return json(response, 200, PublicHistorySchema.parse({ schemaVersion: 1, scope: 'public-world-history', streamId: snapshot.streamId, asOfCursor: snapshot.cursor, ...page }));
        }
        if (view === 'resident-discovery') {
          const id = Number(url.searchParams.get('resident'));
          const identity = snapshot.facts.find(f => f.code === 'resident.identity' && f.subjects[0].id === id);
          if (!identity) return json(response, 404, { status: 'unknown-resident' });
          return json(response, 200, PublicDiscoverySchema.parse({ schemaVersion: 1, scope: 'public-world-observations', streamId: snapshot.streamId, asOfCursor: snapshot.cursor,
            resident: { kind: 'resident', id }, facts: snapshot.facts.filter(f => f.code === 'resident.measurements' && f.subjects[0].id === id), noteCode: 'since-public-baseline' }));
        }
        return json(response, 404, { status: 'unknown-view' });
      }
      if (url.pathname === '/events') {
        const after = Number(url.searchParams.get('after'));
        if (!Number.isSafeInteger(after) || after < 0) return json(response, 400, { status: 'invalid-cursor' });
        if (clients.size >= 16) return json(response, 503, { status: 'viewer-limit' });
        const events = world.publicEventsAfter(after);
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        response.flushHeaders();
        clients.add(response);
        request.on('close', () => clients.delete(response));
        for (const event of events) { if (!clients.has(response)) break; send(response, event); }
        return;
      }
      return json(response, 404, { status: 'not-found' });
    } catch {
      if (!response.headersSent) json(response, 503, { status: 'resync-required' });
      else response.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); }
  catch (error) { world.close(); throw error; }
  const timer = setInterval(() => {
    try { for (const event of world.advance(1)) for (const client of clients) send(client, event); }
    catch { failed = true; clearInterval(timer); for (const client of clients) client.end(); clients.clear(); }
  }, tick);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local listener unavailable');
  return { port: address.port, async close() {
    if (closed) return;
    closed = true; clearInterval(timer); presence.close();
    for (const client of clients) client.end();
    clients.clear(); server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    world.close();
  } };
}
