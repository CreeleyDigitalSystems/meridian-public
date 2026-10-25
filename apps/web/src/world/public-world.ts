import { PUBLIC_GIVEN_NAMES, PUBLIC_FAMILY_NAMES, type PublicFact, type PublicSnapshot, validatePublicSnapshot } from '@meridian/world-schema/public-world';
import { transitJourneyPhase, transitTimetable, transitVehicleAt } from '@meridian/world-schema/transit';
import type { ResidentVisualState, ResidentJourneyVisual, FrontierParcelVisual, FrontierWorksiteVisual, TransitCircuitVisual, VentureSiteVisual, ConstructionStage } from '@meridian/visual-world';
import { FRONTIER_BUILD_EFFORT } from '../../../../packages/visual-world/src/frontier-visuals.js';
type Fact<C extends PublicFact['code']> = Extract<PublicFact, {
  code: C;
}>;
export interface PublicResident {
  id: string;
  ref: number;
  name: string;
  lifeStage: 'adult' | 'child';
  occupation: string;
  placeId: string;
  homeId: string;
  workId: string;
  activity: string;
  visual: ResidentVisualState;
  task?: Fact<'resident.task'>['values'];
  vitals?: Fact<'resident.vitals'>['values'];
  measurements: Fact<'resident.measurements'>['values']['readings'];
}
export interface PublicPlace {
  id: string;
  ref: number;
  name: string;
  kind: string;
  anchor?: string | undefined;
}
export interface PublicCityView {
  streamId: string;
  cursor: number;
  revision: string;
  minute: number;
  mode: 'founding' | 'city' | 'life';
  seed: string;
  residents: PublicResident[];
  places: PublicPlace[];
  construction: {
    placeId: string;
    stage: ConstructionStage;
    minute: number;
  } | null;
  projects: {
    id: string;
    placeId: string;
    label: string;
    progress: number;
    kind: 'garden' | 'civic';
    labelKey: string;
  }[];
  frontier: FrontierParcelVisual[];
  /** Meridian Central's circuit and where its timetable puts the vehicle at this public minute; absent until commissioned. */
  transit?: TransitCircuitVisual | undefined;
  ventureSites: VentureSiteVisual[];
  ventures: Fact<'venture.state'>[];
  materials: Fact<'venture.materials'>[];
  objects: Fact<'object.ownership'>[];
  commitments: Fact<'commitment.state'>[];
  surveys: Fact<'place.survey'>[];
}
export const residentKey = (id: number) => `public-resident:${id}`;
export const placeKey = (id: number) => `public-place:${id}`;
export function label(code: string): string {
  return code === 'unavailable' ? 'Unavailable' : code.split('-').map(s => s[0]!.toUpperCase() + s.slice(1)).join(' ');
}
export async function validateCurrentPublicSnapshot(input: unknown): Promise<PublicSnapshot> {
  const snapshot = await validatePublicSnapshot(input);
  if (snapshot.facts.some(f => f.code === 'place.state' && (f.values.layoutKey === 'home' || f.values.layoutKey === 'work') && f.values.anchorSlot === undefined)) throw new Error('prior presentation policy');
  if (snapshot.facts.some(f => f.code === 'resident.identity' && (f.values.age !== undefined || f.values.lifeStage === 'child' && f.values.nameKey !== 'alias'))) throw new Error('unsafe prior public policy');
  return snapshot;
}
function name(f: Fact<'resident.identity'>): string {
  if (f.values.lifeStage === 'child') return `Child ${f.subjects[0].id}`;
  const key = f.values.nameKey;
  if (key === 'luna') return 'Luna';
  if (key === 'sol') return 'Sol';
  const match = /^catalogue-(\d+)-(\d+)$/.exec(key);
  return match ? `${PUBLIC_GIVEN_NAMES[Number(match[1])]} ${PUBLIC_FAMILY_NAMES[Number(match[2])]}` : `Resident ${f.subjects[0].id}`;
}
/** Explicit public facts → renderer and inspection DTO. Never an internal snapshot. */
export function publicCityView(snapshot: PublicSnapshot): PublicCityView {
  const facts = <C extends PublicFact['code'],>(code: C): Fact<C>[] => snapshot.facts.filter((f): f is Fact<C> => f.code === code);
  const render = facts('world.render')[0]!.values;
  const places = facts('place.state').map(f => {
    const v = f.values;
    const anchor = v.anchorSlot && (v.layoutKey === 'home' || v.layoutKey === 'work') ? `${v.layoutKey}-${String(v.anchorSlot).padStart(2, '0')}` : v.layoutKey === 'frontier' && v.ring !== undefined && v.slot !== undefined ? `${v.nameKey === "landing" ? "landing" : "frontier"}-${v.ring}-${v.slot}` : ['founders-square', 'founding-district-site', 'city-market', 'city-garden', 'city-promenade'].includes(v.nameKey) ? v.nameKey : undefined;
    const title = v.nameKey === 'alias' ? `Place ${f.subjects[0].id}` : v.nameKey === 'home' || v.nameKey === 'family-home' || v.nameKey === 'empty-home' ? `Home ${f.subjects[0].id}` : v.nameKey === 'work' ? `Workplace ${f.subjects[0].id}` : label(v.nameKey);
    return {
      id: placeKey(f.subjects[0].id),
      ref: f.subjects[0].id,
      name: title,
      kind: v.kind,
      anchor
    };
  });
  const anchor = (id: number) => places.find(p => p.ref === id)?.anchor;
  const parcelAt = (id: number) => facts('parcel.state').find(p => p.subjects[0].id === id)?.values;
  /** A frontier shift's public worksite, so the scene draws the resident there rather than at a city locator. */
  const worksite = (task: Fact<'resident.task'>['values'] | undefined): FrontierWorksiteVisual | undefined => {
    const trip = task?.trip ?? (task?.returnTrip ? {...task.returnTrip,phase:"returning" as const}:undefined);
    if (!task || !trip) return undefined;
    if (trip.site.kind === 'quay') return {
      phase: trip.phase,
      kind: 'quay',
      sector: trip.site.sector
    };
    const ground = parcelAt(trip.site.parcel.id),
      facing = task.kind !== 'build' && task.parcel ? parcelAt(task.parcel.id) : undefined;
    return ground ? {
      phase: trip.phase,
      kind: 'ground',
      ring: ground.ring,
      slot: ground.slot,
      facing: facing ? {
        ring: facing.ring,
        slot: facing.slot
      } : undefined
    } : undefined;
  };
  // Meridian Central: the published circuit as parcel cells, and the vehicle where the shared timetable puts it now.
  const transitFact = facts('transit.state')[0];
  const parcelCell = (id: number) => {
    const p = facts('parcel.state').find(f => f.subjects[0].id === id)?.values;
    return p ? {
      ring: p.ring,
      slot: p.slot
    } : undefined;
  };
  const transitRoute = transitFact?.values.route ? {
    path: transitFact.values.route.path.map(r => parcelCell(r.id)!),
    stops: transitFact.values.route.stops
  } : null;
  let transit: TransitCircuitVisual | undefined;
  if (transitFact) {
    let vehicle: TransitCircuitVisual['vehicle'] = {
      kind: 'dwell',
      at: null
    };
    if (transitRoute) {
      const timetable = transitTimetable(transitRoute),
        at = transitVehicleAt(timetable, transitFact.values.anchorMinute, snapshot.minute),
        segment = timetable.segments[at.segment]!;
      vehicle = segment.kind === 'dwell' ? {
        kind: 'dwell',
        at: segment.stop
      } : {
        kind: 'run',
        from: segment.from,
        to: segment.to,
        progress: at.elapsed / segment.minutes
      };
    }
    transit = {
      revision: transitFact.values.revision,
      route: transitRoute,
      vehicle
    };
  }
  /** A resident's saved crossing at this public minute, with the platform as a stop on the published circuit (null: Central). */
  const journey = (task: Fact<'resident.task'>['values'] | undefined): ResidentJourneyVisual | undefined => {
    const j = task?.journey;
    if (!task || !j) return undefined;
    const phase = transitJourneyPhase(j, snapshot.minute);
    if (phase === 'arrived') return undefined;
    const toPlaceId = anchor(task.place.id);
    if (!toPlaceId) return undefined;
    const station = phase === 'to-platform' ? j.ride.from : phase === 'onward' ? j.ride.to : null;
    const route = transitFact?.values.route;
    // The stop that calls at the station's parcel (a circuit may pass that parcel earlier without calling there).
    const platform = station === null ? null : route ? route.stops.findIndex(i => route.path[i]?.id === station.id) : -1;
    return platform === -1 ? undefined : {
      phase,
      platform,
      toPlaceId
    };
  };
  const residents = facts('resident.identity').map(f => {
    const id = f.subjects[0].id,
      presence = facts('resident.presence').find(p => p.subjects[0].id === id)!;
    const task = facts('resident.task').find(p => p.subjects[0].id === id)?.values;
    const visual: ResidentVisualState = {
      id: residentKey(id),
      placeId: anchor(presence.subjects[1].id) ?? 'unavailable',
      homePlaceId: anchor(presence.subjects[2].id),
      publicPresentation: true,
      persona: f.values.nameKey === 'luna' ? 'luna' : f.values.nameKey === 'sol' ? 'sol' : undefined,
      lifeStage: f.values.lifeStage === 'child' ? 'child' : undefined,
      walking: presence.values.motion === 'walking',
      taskKind: task?.kind,
      partnerId: task?.partner ? residentKey(task.partner.id) : undefined,
      appearance: facts('resident.appearance').find(p => p.subjects[0].id === id)?.values,
      originalPresentation: facts('resident.appearance').find(p => p.subjects[0].id === id)?.values.originalPresentation,
      frontierSite: worksite(task),
      journey: journey(task)
    };
    return {
      id: residentKey(id),
      ref: id,
      name: name(f),
      lifeStage: f.values.lifeStage,
      occupation: label(f.values.occupationCode),
      placeId: placeKey(presence.subjects[1].id),
      homeId: placeKey(presence.subjects[2].id),
      workId: placeKey(presence.values.work.id),
      activity: presence.values.activity,
      visual,
      ...(task ? {
        task
      } : {}),
      ...(facts('resident.vitals').find(p => p.subjects[0].id === id) ? {
        vitals: facts('resident.vitals').find(p => p.subjects[0].id === id)!.values
      } : {}),
      measurements: facts('resident.measurements').find(p => p.subjects[0].id === id)?.values.readings ?? []
    };
  });
  const construction = facts('construction.state')[0];
  const projects = facts('project.state').map(f => ({
    id: `public-project:${f.subjects[0].id}`,
    placeId: placeKey(f.subjects[1].id),
    label: label(f.values.labelKey),
    labelKey: f.values.labelKey,
    progress: f.values.progress,
    kind: f.values.kind
  }));
  const frontier: FrontierParcelVisual[] = facts('parcel.state').map(f => ({
    id: `public-parcel:${f.subjects[0].id}`,
    ring: f.values.ring,
    slot: f.values.slot,
    state: f.values.place ? 'built' : f.values.build ? 'building' : f.values.state,
    buildKind: f.values.builtKind ?? f.values.build?.kind,
    progress: f.values.build ? Math.min(1, f.values.build.effort / FRONTIER_BUILD_EFFORT[f.values.build.kind]) : undefined
  }));
  const ventures = facts('venture.state'),
    materials = facts('venture.materials');
  const rank: Record<string, number> = {
    active: 2,
    resourcing: 1,
    completed: 0
  };
  const candidates = ventures.filter(f => (f.values.status === 'active' || f.values.status === 'resourcing') && !f.values.outcome || f.values.status === 'completed' && f.values.outcome?.result === 'completed' && f.values.steps.every(s => s.status === 'done')).sort((a, b) => rank[b.values.status]! - rank[a.values.status]! || b.values.proposedMinute - a.values.proposedMinute || a.subjects[0].id - b.subjects[0].id);
  const ventureSites: VentureSiteVisual[] = [];
  for (const placeId of ['city-garden', 'city-market', 'city-promenade']) {
    const f = candidates.find(f => anchor(f.subjects[1].id) === placeId);
    if (!f) continue;
    const m = materials.find(m => m.subjects[0].id === f.subjects[0].id)?.values;
    ventureSites.push({
      ventureId: `public-venture:${f.subjects[0].id}`,
      placeId,
      status: f.values.status as VentureSiteVisual['status'],
      doneSteps: f.values.steps.filter(s => s.status === 'done').length,
      totalSteps: f.values.steps.length,
      timber: f.values.status === 'completed' ? 0 : m?.timber.reserved ?? 0,
      stone: f.values.status === 'completed' ? 0 : m?.stone.reserved ?? 0
    });
  }
  return {
    streamId: snapshot.streamId,
    cursor: snapshot.cursor,
    revision: snapshot.revision,
    minute: snapshot.minute,
    mode: render.mode,
    seed: `public-terrain-${render.terrainVersion}-${render.terrainSeed}`,
    residents,
    places,
    construction: construction ? {
      placeId: placeKey(construction.subjects[1].id),
      stage: construction.values.stage,
      minute: construction.minute
    } : null,
    projects,
    frontier,
    ...(transit ? {
      transit
    } : {}),
    ventureSites,
    ventures,
    materials,
    objects: facts('object.ownership'),
    commitments: facts('commitment.state'),
    surveys: facts('place.survey')
  };
}
