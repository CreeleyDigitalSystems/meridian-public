import {
  transitLandingPlaceId, type TransitLanding, TRANSIT_DISTRICT_ORDER, TRANSIT_MAX_PATH, TransitRouteSchema, transitAtCentralStart, transitCellsAdjacent, transitChannelSlots, transitDistrict,
  type FrontierParcel, type TransitCell, type TransitRoute, type TransitState, type WorldEvent, type WorldState,
} from "@meridian/world-schema";

/**
 * Meridian Central's circuit (Transport Ruling, 22 Oct 2026), derived deterministically from the charted frontier.
 *
 * The outer districts are the eight compass octants; every parcel lies wholly in one. A district is developed
 * once residents have founded a place on charted ground there, and it then gets one station: its founded parcel
 * nearest the city. The circuit leaves Central over the water ONCE, lands on a ring-1 parcel, calls at the
 * developed districts' stations in clockwise order over connected charted ground, and returns over the water
 * ONCE from a different ring-1 parcel. Fog is never crossed: the circuit runs within one connected stretch of
 * charted ground, so every station is reachable from both landings, and a place in a stretch the circuit
 * cannot reach is reported as unserved, never drawn as served.
 *
 * Stations are only added as districts develop. A newly derived circuit waits as `pending` until the vehicle
 * next stands at Central, so it never jumps along the rail and nobody is aboard when it changes; in steady
 * state no event is written.
 *
 * Seam with canonical travel: a resident's crossing is walk → `TransitRide` → walk, saved on their task as a
 * `TransitJourney` (transit-journey.ts) and checked every minute. This module supplies the reachability
 * (`transitStationFor`, `transitUnservedPlaces`) and the schema module the ride (`planTransitRide`,
 * `transitRideHolds`). Ground connectivity is the frontier's own grid (ring neighbours and the inward parent),
 * the same relation the spatial lane's walkers use. Transit keeps no second store of resident locations.
 */

const MAX_RING = 64;

const key = (c: TransitCell) => `parcel:${c.ring}:${c.slot}`;
const byPosition = (a: TransitCell, b: TransitCell) => a.ring - b.ring || a.slot - b.slot;
/** A ring-1 parcel's place in the clockwise sweep from Central (ring-1 slot d spans district d). */
const clockwise = (landing: TransitCell) => TRANSIT_DISTRICT_ORDER.indexOf(landing.slot);

/** Parcels the frontier connects to this one (ring neighbours, inward parent, outward children), in ring/slot order so every search is deterministic. */
function neighbours(c: TransitCell): TransitCell[] {
  const slots = 8 * c.ring;
  const out: TransitCell[] = [{ ring: c.ring, slot: (c.slot + slots - 1) % slots }, { ring: c.ring, slot: (c.slot + 1) % slots }];
  for (const ring of [c.ring - 1, c.ring + 1]) {
    if (ring < 1 || ring > MAX_RING) continue;
    const low = Math.floor((c.slot * ring) / c.ring), high = Math.floor(((c.slot + 1) * ring - 1) / c.ring);
    for (let slot = low; slot <= high; slot += 1) if (transitCellsAdjacent(c, { ring, slot })) out.push({ ring, slot });
  }
  return out.sort(byPosition);
}

/** Fewest hops over allowed parcels, ties broken by ring/slot order. */
function shortestPath(from: TransitCell, to: TransitCell, allowed: (c: TransitCell) => boolean): TransitCell[] | undefined {
  const goal = key(to);
  if (key(from) === goal) return [from];
  const parent = new Map<string, TransitCell | null>([[key(from), null]]);
  let layer = [from];
  while (layer.length > 0) {
    const next: TransitCell[] = [];
    for (const cell of layer) for (const n of neighbours(cell)) {
      const k = key(n);
      if (parent.has(k) || !allowed(n)) continue;
      parent.set(k, cell);
      if (k === goal) {
        const path = [n];
        for (let at = parent.get(k); at; at = parent.get(key(at))) path.push(at);
        return path.reverse();
      }
      next.push(n);
    }
    layer = next;
  }
  return undefined;
}

const chartedParcels = (frontier: Readonly<Record<string, FrontierParcel>>) =>
  new Map(Object.values(frontier).filter((p) => p.state === "charted").sort(byPosition).map((p) => [key(p), p] as const));

/**
 * Connected stretches of charted ground, each found from its ring-1 parcels. A parcel is revealed only once its
 * inward parent is charted and the two are connected, so every charted parcel belongs to one.
 */
function chartedStretches(charted: ReadonlyMap<string, FrontierParcel>): FrontierParcel[][] {
  const seen = new Set<string>();
  const stretches: FrontierParcel[][] = [];
  for (const start of charted.values()) {
    if (start.ring !== 1 || seen.has(key(start))) continue;
    const members: FrontierParcel[] = [];
    seen.add(key(start));
    let layer: TransitCell[] = [start];
    while (layer.length > 0) {
      const next: TransitCell[] = [];
      for (const cell of layer) {
        members.push(charted.get(key(cell))!);
        for (const n of neighbours(cell)) {
          const k = key(n);
          if (seen.has(k) || !charted.has(k)) continue;
          seen.add(k);
          next.push(n);
        }
      }
      layer = next;
    }
    stretches.push(members.sort(byPosition));
  }
  return stretches;
}

/**
 * The two landings of a stretch: with the whole first ring charted, either side of Central (slots 4 and 3);
 * otherwise the ends of its run of charted ring-1 slots, so the sweep from outbound to return never doubles back
 * over fog. (Fixtures that chart without ancestry can leave several runs: the widest fog gap is left unswept,
 * then the shorter crossings.)
 */
function landingsOf(members: readonly FrontierParcel[]): { outbound: TransitCell; back: TransitCell } | undefined {
  const slots = new Set(members.filter((p) => p.ring === 1).map((p) => p.slot));
  if (slots.size < 2) return undefined;
  if (slots.size === 8) return { outbound: { ring: 1, slot: 4 }, back: { ring: 1, slot: 3 } };
  const options = [...slots].filter((slot) => !slots.has((slot + 7) % 8)).map((outbound) => {
    let back = (outbound + 7) % 8;
    while (!slots.has(back)) back = (back + 7) % 8;
    return { outbound, back, gap: (outbound - back + 7) % 8, crossing: transitChannelSlots({ ring: 1, slot: outbound }) + transitChannelSlots({ ring: 1, slot: back }) };
  }).sort((a, b) => b.gap - a.gap || a.crossing - b.crossing || a.outbound - b.outbound);
  const best = options[0]!;
  return { outbound: { ring: 1, slot: best.outbound }, back: { ring: 1, slot: best.back } };
}

/**
 * The circuit the charted frontier supports now, or null: it needs a stretch of charted ground touching two
 * ring-1 landings with at least one developed district on it. Stations are called at clockwise from the
 * outbound landing. The stretch with the most developed districts wins, then the one with the shorter crossings,
 * then the one whose outbound landing comes first clockwise from Central. Pure and order-independent: the same
 * frontier always gives the same route.
 */
export function deriveTransitRoute(frontier: Readonly<Record<string, FrontierParcel>> | undefined): TransitRoute | null {
  if (!frontier) return null;
  const candidates = chartedStretches(chartedParcels(frontier)).flatMap((members) => {
    const landings = landingsOf(members);
    if (!landings) return [];
    const order = Array.from({ length: 8 }, (_, i) => (landings.outbound.slot + i) % 8);
    let stations = order.map((district) => members.find((p) => p.placeId !== undefined && transitDistrict(p) === district)).filter((p): p is FrontierParcel => p !== undefined);
    // Before any district exists, an explicit commissioned platform on charted ground breaks the founding
    // dependency. It grants no charting, materials, building effort, home or developed-district claim.
    if (!stations.length) stations = [members.find(p => p.id === key(landings.outbound))!];
    return stations.length > 0 ? [{ members, ...landings, stations, crossing: transitChannelSlots(landings.outbound) + transitChannelSlots(landings.back) }] : [];
  }).sort((a, b) => b.stations.length - a.stations.length || a.crossing - b.crossing || clockwise(a.outbound) - clockwise(b.outbound));
  const chosen = candidates[0];
  if (!chosen) return null;
  const stretch = new Set(chosen.members.map(key));
  const allowed = (c: TransitCell) => stretch.has(key(c));
  const waypoints: TransitCell[] = [chosen.outbound, ...chosen.stations, chosen.back];
  const path: TransitCell[] = [];
  const stops: number[] = [];
  for (let i = 0; i + 1 < waypoints.length; i += 1) {
    const leg = shortestPath(waypoints[i]!, waypoints[i + 1]!, allowed);
    if (!leg) return null; // unreachable within one stretch: cannot happen, kept as a guard
    path.push(...(path.length === 0 ? leg : leg.slice(1)));
    if (i < chosen.stations.length) stops.push(path.length - 1);
    // Beyond the saved bound (a frontier far larger than any so far): keep the circuit already in service.
    if (path.length > TRANSIT_MAX_PATH) return null;
  }
  return TransitRouteSchema.parse({ path: path.map(key), stops });
}

/** Multi-source walk over charted ground from the circuit's stations: for each reached parcel, its station. */
function walksFromStations(frontier: Readonly<Record<string, FrontierParcel>>, route: TransitRoute): Map<string, { station: string; from: string | null }> {
  const charted = chartedParcels(frontier);
  const reached = new Map<string, { station: string; from: string | null }>();
  let layer: TransitCell[] = [];
  for (const index of route.stops) {
    const station = route.path[index]!;
    const cell = charted.get(station);
    if (!cell || reached.has(station)) continue;
    reached.set(station, { station, from: null });
    layer.push(cell);
  }
  while (layer.length > 0) {
    const next: TransitCell[] = [];
    for (const cell of layer) for (const n of neighbours(cell)) {
      const k = key(n);
      if (reached.has(k) || !charted.has(k)) continue;
      reached.set(k, { station: reached.get(key(cell))!.station, from: key(cell) });
      next.push(n);
    }
    layer = next;
  }
  return reached;
}

/**
 * The station a rider uses for a frontier parcel: the one with the fewest charted parcels to walk (ties: the
 * earlier stop), and that walk from the station's parcel to the target. Undefined when no walk over charted
 * ground reaches it from any station (fog, or a stretch the circuit does not reach).
 */
export function transitStationFor(frontier: Readonly<Record<string, FrontierParcel>> | undefined, route: TransitRoute | null, parcelId: string): { station: string; walk: string[] } | undefined {
  if (!frontier || !route) return undefined;
  const reached = walksFromStations(frontier, route);
  const hit = reached.get(parcelId);
  if (!hit) return undefined;
  const walk = [parcelId];
  for (let at = hit.from; at !== null; at = reached.get(at)!.from) walk.push(at);
  return { station: hit.station, walk: walk.reverse() };
}

/**
 * True when a walk over charted ground joins the two parcels: they lie on one connected stretch, with no water
 * or fog between them. Parcels on separate stretches are joined by nothing lawful (the one circuit serves one
 * stretch), so a move between them is never a ground relocation.
 */
export function transitGroundJoins(frontier: Readonly<Record<string, FrontierParcel>> | undefined, fromParcelId: string, toParcelId: string): boolean {
  if (!frontier) return false;
  const charted = chartedParcels(frontier);
  const from = charted.get(fromParcelId), to = charted.get(toParcelId);
  return from !== undefined && to !== undefined && shortestPath(from, to, (c) => charted.has(key(c))) !== undefined;
}

/** Founded places on the frontier that no station's walk reaches: listed, never shown as served. */
export function transitUnservedPlaces(frontier: Readonly<Record<string, FrontierParcel>> | undefined, route: TransitRoute | null): string[] {
  if (!frontier) return [];
  const reached = route ? walksFromStations(frontier, route) : new Map();
  return Object.values(frontier).filter((p) => p.placeId !== undefined && !reached.has(p.id)).sort(byPosition).map((p) => p.id);
}

/** Key-order independent comparison: saved, replayed and freshly derived records may list keys differently. */
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(value);
const sameRoute = (a: TransitRoute | null, b: TransitRoute | null) => canonical(a) === canonical(b);

/** New physical landing anchors required by a provisional stop; all other stops remain founded places. */
export function transitLandings(state: WorldState, route: TransitRoute | null): TransitLanding[] {
  if (!route) return [];
  return route.stops.flatMap(index => {
    const parcelId = route.path[index]!, parcel = state.life?.frontier?.[parcelId];
    const id = transitLandingPlaceId(parcelId);
    if (!parcel || parcel.state !== "charted" || parcel.placeId || Object.hasOwn(state.places, id)) return [];
    return [{ id, name: `Meridian pioneer platform ${parcel.slot + 1}`, kind: "civic" as const }];
  });
}
const withLandings = (state: WorldState, landings: readonly TransitLanding[]): WorldState => ({ ...state, places: { ...state.places, ...Object.fromEntries(landings.map(p => [p.id, p])) } });

/**
 * One-time zero-minute commissioning of Meridian Central (explicit operator upgrade, not resident construction).
 * The vehicle starts parked at Central; the derived circuit, if any, goes into service at once.
 */
export function commissionTransit(input: WorldState): { state: WorldState; event?: Extract<WorldEvent, { type: "transit-commissioned" }> } {
  if (input.engineVersion !== "city-life-2" || !input.life || input.life.transit) return { state: input };
  const route = deriveTransitRoute(input.life.frontier);
  const minute = input.canonicalMinute;
  const transit: TransitState = { version: 1, commissionedMinute: minute, revision: route ? 1 : 0, anchorMinute: minute, route, pending: null };
  const landings = transitLandings(input, route);
  const state = withLandings(structuredClone(input), landings);
  state.life!.transit = structuredClone(transit);
  return { state, event: { type: "transit-commissioned", minute, after: transit, ...(landings.length ? { landings } : {}) } };
}

/** Only a parcel being charted or a place being founded can change the circuit; effort and crews cannot. */
const frontierChanged = (events: readonly WorldEvent[]) => events.some((e) => e.type === "life-frontier-changed"
  && (e.before?.state !== e.after.state || e.before?.placeId !== e.after.placeId));

/**
 * The transit record after one minute. Only a frontier change can alter the derived circuit; a changed one waits
 * as pending until the vehicle stands at Central at the start of a circuit, then goes into service. Returns the
 * same object when nothing changes.
 */
export function stepTransit(transit: TransitState, frontier: Readonly<Record<string, FrontierParcel>> | undefined, minute: number, changed: boolean): TransitState {
  let after = transit;
  if (changed) {
    const derived = deriveTransitRoute(frontier);
    if (derived && after.route === null) after = { ...after, revision: after.revision + 1, anchorMinute: minute, route: derived, pending: null };
    else if (derived && !sameRoute(derived, after.pending ?? after.route)) after = { ...after, pending: sameRoute(derived, after.route) ? null : derived };
  }
  if (after.pending && transitAtCentralStart(after, minute)) after = { ...after, revision: after.revision + 1, anchorMinute: minute, route: after.pending, pending: null };
  return after;
}

/** Applies a minute's transit change after that minute's resident life. No transit, or no change: no event. */
export function applyTransitMinute(state: WorldState, minute: number, minuteEvents: readonly WorldEvent[]): { state: WorldState; events: WorldEvent[] } {
  const transit = state.life?.transit;
  if (!transit) return { state, events: [] };
  const after = stepTransit(transit, state.life!.frontier, minute, frontierChanged(minuteEvents));
  if (after === transit) return { state, events: [] };
  const landings = transitLandings(state, after.route);
  return { state: { ...withLandings(state, landings), life: { ...state.life!, transit: after } }, events: [{ type: "transit-changed", minute, before: transit, after, ...(landings.length ? { landings } : {}) }] };
}

/** Replay check: a committed minute's transit record is exactly what the kernel derives from its source. */
export function validateTransitMinute(before: TransitState | undefined, after: WorldState, minute: number, minuteEvents: readonly WorldEvent[]): void {
  const now = after.life?.transit;
  if (before === undefined && now === undefined) return;
  if (before === undefined || now === undefined) throw new Error("transit cannot appear or vanish within a minute");
  const expected = stepTransit(before, after.life!.frontier, minute, frontierChanged(minuteEvents));
  // Steady state: nothing was due and nothing was written (the record is the very object the minute began with).
  if (expected === before && now === before) return;
  if (canonical(expected) !== canonical(now)) throw new Error("transit minute provenance mismatch");
}

/** Replay check: a commissioning event is exactly what the kernel would commission from the world it lands on. */
export function validateTransitCommissioning(before: WorldState, event: Extract<WorldEvent, { type: "transit-commissioned" }>): void {
  const expected = commissionTransit(before).event;
  if (!expected || canonical(expected) !== canonical(event)) throw new Error("transit commissioning provenance mismatch");
}
