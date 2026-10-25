import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { get } from 'node:http';

const root = fileURLToPath(new URL('../', import.meta.url));
const enginePath = join(root, 'apps/world-service/src/demo/engine.ts');
const scratch = join(root, '.test-data');
mkdirSync(scratch, { recursive: true });
async function engine() {
  assert.ok(existsSync(enginePath), 'A real synthetic kernel/store/projection entry is required');
  return import(enginePath);
}

test('the integrated synthetic city records real opening events with fog intact, Central idle and wardrobe closed', async () => {
  const { openSyntheticWorld } = await engine();
  const { WorldStore } = await import('../apps/world-service/src/store/world-store.ts');
  const directory = mkdtempSync(join(scratch, 'openings-'));
  let world, store;
  try {
    world = openSyntheticWorld(directory);
    const snapshot = world.snapshot();
    assert.equal(snapshot.state.canonicalMinute, 0);
    assert.equal(Object.keys(snapshot.state.residents).length, 24);
    assert.equal(snapshot.state.life.frontierAccess?.version, 1);
    assert.equal(Object.keys(snapshot.state.life.frontier ?? {}).length, 8);
    assert.ok(Object.values(snapshot.state.life.frontier).every(parcel => parcel.state === 'fog' && !parcel.placeId));
    assert.equal(snapshot.state.life.transit?.commissionedMinute, 0);
    assert.equal(snapshot.state.life.transit.route, null);
    assert.equal(snapshot.state.life.wardrobe, undefined);
    assert.equal(snapshot.state.life.projects['square-benches'].progress, 0);
    const head = world.publicSnapshot();
    assert.ok(head.facts.some(fact => fact.code === 'transit.state' && fact.values.route === null));
    world.close();
    store = WorldStore.open(join(directory, 'synthetic.sqlite'));
    const openings = store.loadLedgerSuffixAfter(0);
    assert.deepEqual(openings.map(entry => entry.event.type), ['civic-projects-migrated', 'frontier-opened', 'frontier-access-enabled', 'transit-commissioned']);
    assert.ok(openings.every(entry => entry.event.minute === 0));
    assert.deepEqual(store.publicSnapshot(), head);
  } finally { store?.close(); world?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('real timed frontier work earns the first circuit and public replay survives cold restart', async () => {
  const { openSyntheticWorld } = await engine();
  const { applyPublicEvent, validatePublicSnapshot, TransitRouteSchema } = await import('../packages/world-schema/src/index.ts');
  const { validateCurrentPublicSnapshot } = await import('../apps/web/src/world/public-world.ts');
  const directory = mkdtempSync(join(scratch, 'bootstrap-'));
  let world;
  try {
    world = openSyntheticWorld(directory);
    let replayed = await validatePublicSnapshot(world.publicSnapshot());
    let travelling = 0, working = 0, firstCircuit;
    for (let minute = 0; minute < 240; minute++) {
      for (const event of world.advance(1)) replayed = await applyPublicEvent(replayed, event);
      const snapshot = world.snapshot();
      for (const [id, profile] of Object.entries(snapshot.state.life.residents)) {
        const task = profile.task;
        if (task?.trip && snapshot.state.canonicalMinute < task.trip.arrivesMinute) {
          travelling++;
          assert.equal(snapshot.state.residents[id].placeId, task.trip.fromPlaceId, 'Departure is preserved until canonical arrival');
        }
        if (task?.trip?.phase === 'working') {
          working++;
          assert.equal(snapshot.state.residents[id].placeId, task.placeId, 'Credited work requires actual worksite presence');
        }
      }
      if (snapshot.state.life.transit.route) { firstCircuit = snapshot; break; }
    }
    assert.ok(firstCircuit, 'Real engine work must earn a connected first circuit within this bounded run');
    assert.ok(travelling > 0 && working > 0);
    TransitRouteSchema.parse(firstCircuit.state.life.transit.route);
    const charted = Object.values(firstCircuit.state.life.frontier).filter(parcel => parcel.state === 'charted');
    assert.ok(charted.length >= 2);
    assert.ok(!Object.keys(firstCircuit.state.places).some(id => id.startsWith('frontier-')), 'The first circuit does not grant a free built place');
    const landings = Object.values(firstCircuit.state.places).filter(place => place.id.startsWith('landing-'));
    assert.ok(landings.length >= 1 && landings.every(place => place.kind === 'civic'));
    const consumed = Object.values(firstCircuit.state.life.ventures.resources).flatMap(resource => resource.terminal).filter(item => item.status === 'consumed');
    assert.ok(consumed.length > 0, 'Useful paid work consumes actual reserved materials');
    const head = world.publicSnapshot();
    assert.deepEqual(replayed, head);
    await validateCurrentPublicSnapshot(head);
    console.log('MEASURE integrated-bootstrap ' + JSON.stringify({ minute: firstCircuit.state.canonicalMinute,
      chartedParcels: charted.length, provisionalCivicLandings: landings.length, circuitStops: firstCircuit.state.life.transit.route.stops.length,
      observedTravellingMinutes: travelling, observedWorkingMinutes: working, consumedReservations: consumed.length,
      canonicalSequence: firstCircuit.ledgerBaseSequence, publicCursor: head.cursor, actualBrowserValidator: true }));
    world.close(); world = openSyntheticWorld(directory);
    assert.deepEqual(world.snapshot(), firstCircuit);
    assert.deepEqual(world.publicSnapshot(), head);
    world.advance(1);
    assert.equal(world.snapshot().state.canonicalMinute, firstCircuit.state.canonicalMinute + 1);
    assert.equal(world.publicSnapshot().streamId, head.streamId);
  } finally { world?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('real city work persists, public replay reproduces the head, and a cold restart continues it', async () => {
  const { openSyntheticWorld } = await engine();
  const { applyPublicEvent, validatePublicSnapshot } = await import('../packages/world-schema/src/public-world.ts');
  const directory = mkdtempSync(join(scratch, 'restart-'));
  let world;
  try {
    world = openSyntheticWorld(directory);
    const baseline = await validatePublicSnapshot(world.publicSnapshot());
    const initial = world.snapshot();
    for (let i = 0; i < 60; i++) world.advance(1);
    const after = world.snapshot();
    assert.equal(after.state.canonicalMinute, 60);
    assert.ok(after.ledgerBaseSequence > initial.ledgerBaseSequence);
    assert.notDeepEqual(after.state.life.residents, initial.state.life.residents);
    assert.ok(Object.values(after.state.life.residents).some(r => r.memories.length > 0), 'real engine tasks must complete');
    console.log('MEASURE synthetic-city ' + JSON.stringify({ minute: after.state.canonicalMinute,
      ledgerSequence: after.ledgerBaseSequence,
      completedTaskMemories: Object.values(after.state.life.residents).reduce((n, r) => n + r.memories.length, 0),
      gardenProgress: after.state.life.projects['public-garden'].progress,
      materialStocks: after.state.life.ventures.resources }));
    const head = world.publicSnapshot();
    let replayed = baseline;
    for (const event of world.publicEventsAfter(baseline.cursor)) replayed = await applyPublicEvent(replayed, event);
    assert.deepEqual(replayed, head);
    assert.ok(!JSON.stringify(head).includes('goal'), 'canonical private fields must not be returned');
    world.close();
    world = openSyntheticWorld(directory);
    assert.deepEqual(world.snapshot(), after);
    assert.deepEqual(world.publicSnapshot(), head);
    world.advance(1);
    assert.equal(world.snapshot().state.canonicalMinute, 61);
    assert.equal(world.publicSnapshot().streamId, head.streamId);
  } finally {
    world?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the demo refuses an unmarked directory and never replaces an unknown database', async () => {
  const { openSyntheticWorld } = await engine();
  const directory = mkdtempSync(join(scratch, 'refuse-'));
  try {
    writeFileSync(join(directory, 'world.sqlite'), 'synthetic-protected-canary');
    assert.throws(() => openSyntheticWorld(directory), /synthetic|directory|marker/);
    assert.equal(readFileSync(join(directory, 'world.sqlite'), 'utf8'), 'synthetic-protected-canary');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('request target parsing refuses invalid or unexpected URL forms without throwing', async () => {
  const { parseLocalRequestTarget } = await engine();
  assert.equal(typeof parseLocalRequestTarget, 'function');
  for (const target of [undefined, '', 'world', 'https://example.invalid/world', '//example.invalid/world', '/world#section', '/world\\section', '/world\n']) {
    assert.doesNotThrow(() => parseLocalRequestTarget(target));
    assert.equal(parseLocalRequestTarget(target), null);
  }
  const allowed = parseLocalRequestTarget('/world?view=city-ledger&limit=20');
  assert.equal(allowed.origin, 'http://127.0.0.1');
  assert.equal(allowed.pathname, '/world');
  assert.equal(allowed.searchParams.get('limit'), '20');
});

test('Saved-world changes uses the exact viewer headers and returns bounded same-stream history at a verified head', async () => {
  const { startDemo } = await engine();
  const { applyPublicEvent, validatePublicSnapshot, PublicHistorySchema } = await import('../packages/world-schema/src/public-world.ts');
  const directory = mkdtempSync(join(scratch, 'viewer-history-'));
  let demo;
  try {
    demo = await startDemo({ directory, port: 0, tickMilliseconds: 30 });
    const origin = `http://127.0.0.1:${demo.port}`;
    const baseline = await validatePublicSnapshot(await (await fetch(origin + '/world', { headers: { accept: 'application/json' } })).json());
    let live = baseline;
    const deadline = Date.now() + 3000;
    while (live.minute < baseline.minute + 3 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      live = await validatePublicSnapshot(await (await fetch(origin + '/world')).json());
    }
    assert.ok(live.minute >= baseline.minute + 3, 'Known canonical clock events must exist before the history request');
    // Match city-experience.tsx exactly, including media type, header limit and cache policy.
    const headers = { accept: 'application/vnd.meridian.city-ledger+json', 'x-meridian-history-limit': '20' };
    const response = await fetch(origin + '/world', { headers, cache: 'no-store' });
    assert.equal(response.status, 200);
    const page = PublicHistorySchema.parse(await response.json());
    assert.equal(page.streamId, baseline.streamId);
    assert.ok(page.events.length >= 3 && page.events.length <= 20);
    assert.equal(page.events[0].cursor, page.asOfCursor);
    let replayed = baseline;
    for (const event of page.events.filter(event => event.cursor > baseline.cursor).reverse()) replayed = await applyPublicEvent(replayed, event);
    assert.equal(replayed.cursor, page.asOfCursor);
    assert.equal(replayed.revision, page.events[0].revision);
    assert.ok(replayed.minute >= baseline.minute + 3);
    const current = await validatePublicSnapshot(await (await fetch(origin + '/world')).json());
    assert.equal(current.streamId, page.streamId);
    assert.ok(current.cursor >= page.asOfCursor);
    const older = PublicHistorySchema.parse(await (await fetch(origin + '/world', { headers: { ...headers,
      'x-meridian-history-limit': '1', 'x-meridian-history-before': String(page.asOfCursor) } })).json());
    assert.equal(older.events.length, 1);
    assert.ok(older.events[0].cursor < page.asOfCursor);
    PublicHistorySchema.parse(await (await fetch(origin + '/world?view=city-ledger&limit=1')).json());
    for (const value of ['0', '101', '01', '1.0', '1, 2', '9007199254740992']) {
      assert.equal((await fetch(origin + '/world', { headers: { ...headers, 'x-meridian-history-limit': value } })).status, 400);
    }
    for (const value of ['0', '01', '1.0', '1, 2', '9007199254740992']) {
      assert.equal((await fetch(origin + '/world', { headers: { ...headers, 'x-meridian-history-before': value } })).status, 400);
    }
    assert.equal((await fetch(origin + '/world', { headers: { 'x-meridian-history-limit': '20' } })).status, 400);
    assert.equal((await fetch(origin + '/world', { headers: { ...headers, 'x-meridian-history-extra': '1' } })).status, 400);
    assert.equal((await fetch(origin + '/world?view=city-ledger', { headers })).status, 400);
    for (const accept of ['application/vnd.meridian.private+json', 'application/vnd.meridian.city-ledger+json; q=1', 'application/json, application/vnd.meridian.city-ledger+json']) {
      assert.equal((await fetch(origin + '/world', { headers: { accept } })).status, 406);
    }
    assert.equal((await fetch(origin + '/health', { headers })).status, 400);
    assert.equal((await fetch(origin + '/letters')).status, 404);
    assert.equal((await fetch(origin + '/world?view=canonical')).status, 404);
    console.log('MEASURE viewer-history ' + JSON.stringify({ exactViewerRequest: true, streamMatches: true,
      baselineMinute: baseline.minute, replayedMinute: replayed.minute, historyHead: page.asOfCursor,
      historyEvents: page.events.length, currentCursor: current.cursor, validatedReplay: true }));
  } finally {
    await demo?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the loopback HTTP service advances without providers and serves only public snapshot/history/discovery', async () => {
  const { startDemo } = await engine();
  const { applyPublicEvent, validatePublicSnapshot, PublicHistorySchema, PublicDiscoverySchema } = await import('../packages/world-schema/src/public-world.ts');
  const directory = mkdtempSync(join(scratch, 'http-'));
  let demo;
  try {
    demo = await startDemo({ directory, port: 0, tickMilliseconds: 15 });
    const origin = `http://127.0.0.1:${demo.port}`;
    const first = await validatePublicSnapshot(await (await fetch(origin + '/world')).json());
    await new Promise(r => setTimeout(r, 120));
    const next = await validatePublicSnapshot(await (await fetch(origin + '/world')).json());
    assert.ok(next.minute > first.minute);
    PublicHistorySchema.parse(await (await fetch(origin + '/world?view=city-ledger&limit=20')).json());
    const resident = next.facts.find(f => f.code === 'resident.identity').subjects[0].id;
    PublicDiscoverySchema.parse(await (await fetch(origin + '/world?view=resident-discovery&resident=' + resident)).json());
    assert.equal(typeof EventSource, 'function', 'Run tests with the native Node --experimental-eventsource API');
    const source = new EventSource(origin + '/events?after=' + next.cursor);
    let received;
    try {
      received = await new Promise((resolve, reject) => {
        const messages = [];
        const timeout = setTimeout(() => reject(new Error('Native EventSource did not dispatch three city updates')), 5000);
        source.onerror = () => { clearTimeout(timeout); reject(new Error('Native EventSource failed')); };
        source.onmessage = message => {
          try {
            const event = JSON.parse(message.data);
            assert.equal(message.lastEventId, String(event.cursor));
            messages.push(event);
            if (messages.length === 3) { clearTimeout(timeout); source.close(); resolve(messages); }
          } catch (error) { clearTimeout(timeout); reject(error); }
        };
      });
    } finally { source.close(); }
    let replayed = next;
    for (const event of received) replayed = await applyPublicEvent(replayed, event);
    assert.equal(replayed.cursor, received.at(-1).cursor);
    assert.ok(replayed.minute > next.minute);
    assert.ok(received.every((event, index) => event.cursor === next.cursor + index + 1));
    const live = await validatePublicSnapshot(await (await fetch(origin + '/world')).json());
    assert.equal(live.streamId, replayed.streamId);
    assert.ok(live.minute >= replayed.minute);
    console.log('MEASURE native-eventsource ' + JSON.stringify({ nativeConsumer: true, messages: received.length,
      baselineMinute: next.minute, appliedMinute: replayed.minute, currentMinute: live.minute,
      cursors: received.map(event => event.cursor), validatedReplay: true }));
    assert.equal((await fetch(origin + '/world', { method: 'POST' })).status, 405);
    assert.equal((await fetch(origin + '/letters')).status, 404);
    assert.equal((await fetch(origin + '/world?view=canonical')).status, 404);
    // A regular Node HTTP client sends the valid absolute-form used by proxies; this local viewer refuses it.
    const refused = await new Promise((resolve, reject) => {
      const request = get({ hostname: '127.0.0.1', port: demo.port, path: 'https://example.invalid/world' }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      });
      request.on('error', reject);
    });
    assert.deepEqual(refused, { status: 400, body: { status: 'invalid-target' } });
    assert.equal((await fetch(origin + '/health')).status, 200);
  } finally {
    await demo?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
