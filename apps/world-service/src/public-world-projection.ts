import { admitResidentAffordances } from './public-resident-affordances.js';
import { createHash } from 'node:crypto';
import { CIVIC_PROJECTS, VENTURE_TEMPLATES } from '@meridian/world-kernel';
import { ApprovedPublicFactsSchema, AdmissionRegistrySchema, type AdmissionRegistry, PublicSnapshotSchema, PublicFactSchema, PublicEventSchema, PUBLIC_GIVEN_NAMES, PUBLIC_FAMILY_NAMES, publicCanonicalJson, publicFactKey, publicKeyString, publicRevisionInput, transitJourneyPhase, defaultAdultLook, type OriginalPresentations, type PublicKind, type PublicFact, type PublicSnapshot, type PublicEvent, type PublicRef, type WorldState } from '@meridian/world-schema';

/** Private provenance only. This registry is persisted beside the outbox, never in a public response. */
export function createAdmissionRegistry(): AdmissionRegistry {
  return {
    policyVersion: 1,
    entries: []
  };
}
/** Request-specific admission runs before the128 page, against the same verified source and refs.
 * It changes neither spectator checkpoints nor canonical state, and introduces no private observations. */
export function approveFocusedCognition(state: WorldState, input: ApprovedPublicFacts, registry: AdmissionRegistry, focusedResidentIds: readonly string[]): ApprovedPublicFacts {
  if (state.canonicalMinute !== input.minute) throw new Error('cognition source minute mismatch');
  if (focusedResidentIds.length > 20 || new Set(focusedResidentIds).size !== focusedResidentIds.length) throw new RangeError('bounded unique cognition focus required');
  if (!state.life?.invention || !focusedResidentIds.length) return input;
  AdmissionRegistrySchema.parse(registry);
  const facts = ApprovedPublicFactsSchema.parse(input);
  const ref = <K extends PublicKind,>(kind: K, canonicalId: string) => {
    const entry = registry.entries.find(e => e.kind === kind && e.canonicalId === canonicalId);
    if (!entry) throw new Error('unadmitted cognition source reference');
    return {
      kind,
      id: entry.publicId
    };
  };
  const focused = new Map(focusedResidentIds.filter(id => state.residents[id] && state.life?.residents[id]).map(id => [ref('resident', id).id, id]));
  return ApprovedPublicFactsSchema.parse({
    ...facts,
    facts: facts.facts.map(f => {
      if (f.code !== 'resident.affordances') return f;
      const actor = focused.get(f.subjects[0].id);
      if (!actor) return f;
      return {
        ...f,
        minute: state.canonicalMinute,
        values: admitResidentAffordances(state, actor, ref, focusedResidentIds)
      };
    })
  }) as ApprovedPublicFacts;
}

export function publicRevision(s: Pick<PublicSnapshot, 'minute' | 'facts'>): string {
  return createHash('sha256').update(publicRevisionInput(s)).digest('hex');
}
declare const approved: unique symbol;
export type ApprovedPublicFacts = {
  minute: number;
  facts: PublicFact[];
  readonly [approved]: true;
};
const own = <T,>(r: Record<string, T>, id: string): T | undefined => Object.hasOwn(r, id) ? r[id] : undefined;
const occupations = ['Gardener', 'Baker', 'Builder', 'Archivist', 'Ceramicist', 'Transit steward', 'Water keeper', 'Weaver', 'Cook', 'Instrument maker', 'Cartographer', 'Market keeper'] as const;
const occupationCodes = ['gardener', 'baker', 'builder', 'archivist', 'ceramicist', 'transit-steward', 'water-keeper', 'weaver', 'cook', 'instrument-maker', 'cartographer', 'market-keeper'] as const;
function seedNumber(seed: string): number {
  let value = 0;
  for (const char of seed) value = value * 31 + char.charCodeAt(0) >>> 0;
  return value;
}
function reviewedName(state: WorldState, id: string): string {
  const r = state.residents[id]!;
  const family: Record<string, [string, string, boolean]> = {
    'resident-01': ['Sol', 'sol', false],
    'resident-02': ['Luna', 'luna', false]
  };
  const entry = own(family, id);
  if (entry && r.name === entry[0] && r.lifeStage === 'child' === entry[2] && (!entry[2] || r.homePlaceId === 'home-01')) return entry[1];
  const match = /^resident-([0-9]{2,3})$/.exec(id),
    n = match ? Number(match[1]) : 0;
  if (n < 1 || n > 512 || id !== `resident-${String(n).padStart(2, '0')}` || r.lifeStage === 'child') return 'alias';
  if (state.engineVersion === 'founding-1') return 'alias';
  const index = (n - 1 + seedNumber(state.seed)) % 512,
    g = index % 16,
    f = Math.floor(index / 16);
  return r.name === `${PUBLIC_GIVEN_NAMES[g]} ${PUBLIC_FAMILY_NAMES[f]}` ? `catalogue-${g}-${f}` : 'alias';
}

/** Private opening boundary: use exactly the already approved persona rules, never add IDs to public values. */
export function bindOriginalPresentations(state: WorldState): OriginalPresentations {
  return Object.fromEntries(Object.values(state.residents).map(r => {
    const appearance = state.life?.residents[r.id]?.appearance;
    return [r.id, r.lifeStage === 'child' ? { kind: 'procedural' as const } : reviewedName(state, r.id) === 'luna' ? { kind: 'authored-elf' as const } : appearance ? { kind: 'catalogue' as const, look: defaultAdultLook(appearance) } : { kind: 'procedural' as const }];
  }));
}

/** Only typed canonical structure enters here. No memory, goal, intention, label or schedule prose is spread. */
export interface VerifiedPublicObservation {
  residentId: string;
  projectId: string;
  placeId: string;
  minute: number;
  value: number;
  evidenceKind: 'measured' | 'witnessed-change';
}
// Policy1 is frozen accepted0.3 semantics for private historical validation only.
// Policy2 admits affordances and excludes unadmitted child ages.
export type PublicProjectionPolicy = 1 | 2;
/** Private composition capability, never a request or public schema field. Native defaults are unchanged. */
export interface PublicProjectionCapabilities { residentAffordances?: boolean; }
export function approveCanonicalWorld(state: WorldState, registry: AdmissionRegistry, previous?: PublicSnapshot, evidence: Iterable<VerifiedPublicObservation> = [], policy: PublicProjectionPolicy = 2, capabilities: PublicProjectionCapabilities = {}): ApprovedPublicFacts {
  if (policy !== 1 && policy !== 2) throw new Error('unknown public projection policy');
  AdmissionRegistrySchema.parse(registry);
  const current = new Map<PublicKind, Set<string>>();
  const inventory = (kind: PublicKind, ids: string[]) => current.set(kind, new Set(ids));
  inventory('resident', Object.keys(state.residents));
  inventory('place', Object.keys(state.places));
  inventory('construction', [state.construction.id]);
  inventory('project', Object.keys(state.life?.projects ?? {}));
  inventory('object', Object.keys(state.life?.resources ?? {}));
  inventory('commitment', Object.keys(state.life?.commitments ?? {}));
  inventory('parcel', Object.keys(state.life?.frontier ?? {}));
  const ventures = [...Object.values(state.life?.ventures?.projects ?? {}), ...(state.life?.ventures?.retired ?? [])];
  inventory('venture', ventures.map(v => v.id));
  const invention = policy === 2 ? state.life?.invention : undefined;
  for (const [kind, records] of [['workpad', invention?.sites], ['agenda', invention?.agendas], ['consultation', invention?.consultations], ['design', invention?.designs], ['artifact', invention?.artifacts], ['trial', invention?.trials], ['assembly-job', invention?.jobs], ['method', invention?.methods], ['grant',invention?.grants]] as const) inventory(kind, Object.keys(records ?? {}));
  if ([...current.values()].reduce((n, ids) => n + ids.size, 0) > 30000) throw new Error('public inventory bound');
  const admitted = new Map(registry.entries.map(entry => [`${entry.kind}:${entry.canonicalId}`, entry]));
  const nextIds = new Map<PublicKind, number>();
  for (const entry of registry.entries) nextIds.set(entry.kind, Math.max(nextIds.get(entry.kind) ?? 0, entry.publicId));
  for (const [kind, ids] of current) for (const id of [...ids].sort()) {
    const key = `${kind}:${id}`;
    if (admitted.has(key)) continue;
    const publicId = (nextIds.get(kind) ?? 0) + 1;
    const entry: AdmissionRegistry['entries'][number] = {
      kind,
      canonicalId: id,
      publicId,
      source: 'verified-canonical-structure'
    };
    registry.entries.push(entry);
    admitted.set(key, entry);
    nextIds.set(kind, publicId);
  }
  AdmissionRegistrySchema.parse(registry);
  const ref = <K extends PublicKind,>(kind: K, id: string): {
    kind: K;
    id: number;
  } => {
    if (!current.get(kind)?.has(id)) throw new Error('unadmitted source reference');
    const entry = admitted.get(`${kind}:${id}`);
    if (!entry) throw new Error('missing source admission');
    return {
      kind,
      id: entry.publicId
    };
  };
  const founded = new Map(Object.values(state.life?.frontier ?? {}).filter(parcel => parcel.placeId === `frontier-${parcel.ring}-${parcel.slot}`).map(parcel => [parcel.placeId!, parcel]));
  const facts: PublicFact[] = [];
  const old = new Map(previous?.facts.map(f => [publicKeyString(publicFactKey(f)), f]));
  const add = (input: unknown) => {
    let f = PublicFactSchema.parse(input);
    const existing = old.get(publicKeyString(publicFactKey(f)));
    if (existing && publicCanonicalJson({
      code: existing.code,
      subjects: existing.subjects,
      values: existing.values
    }) === publicCanonicalJson({
      code: f.code,
      subjects: f.subjects,
      values: f.values
    })) f = PublicFactSchema.parse({
      code: f.code,
      subjects: f.subjects,
      values: f.values,
      minute: existing.minute
    });
    facts.push(f);
  };
  const emit = (code: PublicFact['code'], subjects: PublicRef[], values: unknown) => add({
    code,
    subjects,
    values,
    minute: state.canonicalMinute
  });
  emit('world.render', [], {
    terrainVersion: 1,
    terrainSeed: 0,
    layoutVersion: 1,
    mode: state.life ? 'life' : state.engineVersion === 'city-1' ? 'city' : 'founding'
  });
  for (const p of Object.values(state.places).sort((a, b) => a.id.localeCompare(b.id))) {
    let nameKey = 'alias',
      layoutKey = 'unavailable';
    const extra: Record<string, unknown> = {};
    const fixed: Record<string, string> = {
      'founders-square': 'Founders Square',
      'founding-district-site': 'Founding District Site',
      'city-market': 'Terrace Market',
      'city-garden': 'Public Garden Terraces',
      'city-promenade': 'Waterside Promenade'
    };
    if (own(fixed, p.id) === p.name) {
      nameKey = p.id;
      layoutKey = p.kind === 'construction' ? 'construction' : 'civic';
    }
    const home = /^home-([0-9]{2,3})$/.exec(p.id),
      work = /^work-([0-9]{2,3})$/.exec(p.id);
    if (home && p.kind === 'residence') {
      nameKey = 'home';
      layoutKey = 'home';
    }
    if (work && p.kind === 'workplace') {
      nameKey = 'work';
      layoutKey = 'work';
    }
    if (p.id === 'home-02' && p.name === 'Empty home') nameKey = 'empty-home';
    const landing = /^landing-1-([0-7])$/.exec(p.id);
    if (landing && policy === 2 && state.life?.frontier?.[`parcel:1:${landing[1]}`]?.state === "charted" && p.kind === "civic") {
      nameKey = "landing"; layoutKey = "frontier"; extra.ring = 1; extra.slot = Number(landing[1]);
    }
    const parcel = founded.get(p.id);
    if (parcel?.builtKind) {
      nameKey = 'frontier';
      layoutKey = 'frontier';
      extra.frontierKind = parcel.builtKind;
      extra.ring = parcel.ring;
      extra.slot = parcel.slot;
    }
    if (policy === 2 && !parcel && (layoutKey === "home" || layoutKey === "work")) {
      const n = Number((home ?? work)![1]);
      // Generic place identity does not imply a physical catalogue footprint. Admit only
      // exact supported slots; preserve the place without inventing a renderer position.
      if (n >= 1 && n <= (home ? 122 : 120) && p.id === `${layoutKey}-${String(n).padStart(2, '0')}`) extra.anchorSlot = n;
      else layoutKey = 'unavailable';
    }
    // All fields below are explicit approved presentation metadata, never source names.
    emit('place.state', [ref('place', p.id)], {
      kind: p.kind,
      nameKey,
      layoutKey,
      ...extra
    });
  }
  for (const r of Object.values(state.residents).sort((a, b) => a.id.localeCompare(b.id))) {
    const rr = ref('resident', r.id),
      child = r.lifeStage === 'child',
      index = occupations.indexOf(r.occupation as typeof occupations[number]);
    emit('resident.identity', [rr], {
      nameKey: reviewedName(state, r.id),
      occupationCode: child ? 'child' : index >= 0 ? occupationCodes[index] : 'unavailable',
      lifeStage: child ? 'child' : 'adult',
      ...(policy === 1 && child && r.age !== undefined ? {
        age: r.age
      } : {})
    });
    const task = state.life?.residents[r.id]?.task;
    const travelling = policy === 2 && (task?.returnTrip !== undefined || task?.trip?.phase === 'travelling' || task?.walk !== undefined && state.canonicalMinute < task.walk.arrivesMinute);
    const journey = policy === 2 ? state.life?.residents[r.id]?.task?.journey : undefined;
    const phase = journey ? transitJourneyPhase(journey, state.canonicalMinute) : undefined;
    emit('resident.presence', [rr, ref('place', r.placeId), ref('place', r.homePlaceId)], {
      activity: r.activity,
      motion: state.life ? travelling || phase === 'to-platform' || phase === 'onward' ? 'walking' : 'stationary' : 'unavailable',
      work: ref('place', r.workPlaceId)
    });
    const profile = state.life?.residents[r.id];
    if (!profile) continue;
    emit('resident.vitals', [rr], {
      energy: profile.needs.energy,
      social: profile.needs.social,
      purpose: profile.needs.purpose,
      work: profile.skills.work,
      gardening: profile.skills.gardening,
      building: profile.skills.building
    });
    const a = profile.appearance;
    // A resident's own chosen look is current-policy presentation only; frozen policy1 never saw one.
    if (a?.presentation.look !== undefined && policy === 1) throw new Error('chosen look requires current public policy');
    if (a) emit('resident.appearance', [rr], {
      catalogueVersion: 1,
      ...(policy === 2 && state.life?.wardrobe?.originals?.[r.id] ? { originalPresentation: state.life.wardrobe.originals[r.id] } : {}),
      fixed: {
        bodyFrame: a.fixed.bodyFrame,
        height: a.fixed.height,
        faceShape: a.fixed.faceShape,
        complexion: a.fixed.complexion,
        eyeStyle: a.fixed.eyeStyle,
        identifyingMark: a.fixed.identifyingMark
      },
      presentation: {
        hairStyle: a.presentation.hairStyle,
        garment: a.presentation.garment,
        trousers: a.presentation.trousers,
        footwear: a.presentation.footwear,
        accessory: a.presentation.accessory,
        ...(a.presentation.look !== undefined ? {
          look: a.presentation.look
        } : {})
      }
    });
    const t = profile.task;
    if (t) {
      if (policy === 1 && ['invention-build', 'assembly-trial', 'invention-teach', 'invention-travel'].includes(t.kind)) throw new Error('new work requires current public policy');
      const values: Record<string, unknown> = {
        kind: t.kind,
        startedMinute: t.startedMinute,
        endsMinute: t.endsMinute,
        choiceOrigin: t.decisionSource === 'engine' ? 'engine' : 'historical-unclassified',
        place: ref('place', t.placeId)
      };
      for (const [source, target, kind] of [['partnerId', 'partner', 'resident'], ['resourceId', 'resource', 'object'], ['projectId', 'project', 'project'], ['commitmentId', 'commitment', 'commitment'], ['ventureId', 'venture', 'venture'], ['parcelId', 'parcel', 'parcel']] as const) {
        const id = t[source];
        if (id !== undefined) values[target] = ref(kind, id);
      }
      if (t.progress !== undefined) values.progress = t.progress;
      if (t.blocker !== undefined) values.blockerCode = 'unavailable';
      if(t.returnTrip){if(policy===1)throw new Error("new work requires current public policy");values.returnTrip={from:ref("place",t.returnTrip.fromPlaceId),arrivesMinute:t.returnTrip.arrivesMinute,site:t.returnTrip.site.kind==="quay"?{kind:"quay",sector:t.returnTrip.site.sector}:{kind:"ground",parcel:ref("parcel",t.returnTrip.site.parcelId)}};}
      if(t.walk) {if(policy===1)throw new Error("new work requires current public policy"); values.walk={from:ref("place",t.walk.fromPlaceId),arrivesMinute:t.walk.arrivesMinute};}
      if (t.trip) {
        if (policy === 1) throw new Error('new work requires current public policy');
        values.trip = {
          phase: t.trip.phase,
          from: ref('place', t.trip.fromPlaceId),
          arrivesMinute: t.trip.arrivesMinute,
          site: t.trip.site.kind === 'quay' ? {
            kind: 'quay',
            sector: t.trip.site.sector
          } : {
            kind: 'ground',
            parcel: ref('parcel', t.trip.site.parcelId)
          }
        };
      }
      if (t.journey) {
        if (policy === 1) throw new Error('new work requires current public policy');
        // The saved crossing as public refs: where they set out, the ride (stations by parcel; null is Meridian
        // Central) and when they arrive. The viewer draws it from these values and the public minute only.
        values.journey = {
          from: ref('place', t.journey.fromPlaceId),
          ride: {
            from: t.journey.ride.from === null ? null : ref('parcel', t.journey.ride.from),
            to: t.journey.ride.to === null ? null : ref('parcel', t.journey.ride.to),
            boardMinute: t.journey.ride.boardMinute,
            departMinute: t.journey.ride.departMinute,
            arriveMinute: t.journey.ride.arriveMinute
          },
          arrivesMinute: t.journey.arrivesMinute
        };
      }
      emit('resident.task', [rr], values);
    }
  }
  emit('construction.state', [ref('construction', state.construction.id), ref('place', state.construction.placeId)], {
    stage: state.construction.stage
  });
  for (const p of Object.values(state.life?.projects ?? {})) {
    const expected = p.id === 'public-garden' ? {
      kind: 'garden',
      placeId: 'city-garden',
      label: 'Public garden renewal'
    } : CIVIC_PROJECTS.find(v => v.id === p.id);
    emit('project.state', [ref('project', p.id), ref('place', p.placeId)], {
      kind: p.kind,
      labelKey: expected && expected.kind === p.kind && expected.placeId === p.placeId && expected.label === p.label ? p.id : 'unavailable',
      progress: p.progress
    });
  }
  for (const r of Object.values(state.life?.resources ?? {})) emit('object.ownership', [ref('object', r.id), ref('resident', r.ownerId)], {
    kind: r.kind,
    labelKey: r.id === 'garden-tools' && r.label === 'Shared garden tools' ? 'garden-tools' : 'unavailable'
  });
  for (const c of Object.values(state.life?.commitments ?? {})) emit('commitment.state', [ref('commitment', c.id), ref('resident', c.requesterId), ref('resident', c.lenderId), ref('object', c.resourceId), ref('project', c.projectId), ref('place', c.placeId)], {
    status: c.status,
    createdMinute: c.createdMinute,
    expiresMinute: c.expiresMinute
  });
  for (const p of Object.values(state.life?.frontier ?? {})) {
    const v: Record<string, unknown> = {
      ring: p.ring,
      slot: p.slot,
      state: p.state,
      effort: p.effort,
      contributors: p.contributors.map(id => ref('resident', id))
    };
    if (p.chartedMinute !== undefined) v.chartedMinute = p.chartedMinute;
    if (p.build) v.build = {
      kind: p.build.kind,
      proposer: ref('resident', p.build.proposerId),
      startedMinute: p.build.startedMinute,
      effort: p.build.effort,
      crew: p.build.crew.map(id => ref('resident', id))
    };
    if (p.placeId) {
      v.place = ref('place', p.placeId);
      v.builtKind = p.builtKind;
      if (p.builtBy !== undefined) v.builtBy = p.builtBy.map(id => ref('resident', id));
    }
    emit('parcel.state', [ref('parcel', p.id)], v);
  }
  // Policy2 only (policy1 stays frozen): commissioned Meridian Central, its circuit as public parcel refs and the
  // vehicle's timetable anchor. The timetable itself is a pure function of these values and the public minute.
  const transit = policy === 2 ? state.life?.transit : undefined;
  if (transit) emit('transit.state', [], {
    commissionedMinute: transit.commissionedMinute,
    revision: transit.revision,
    anchorMinute: transit.anchorMinute,
    route: transit.route ? {
      path: transit.route.path.map(id => ref('parcel', id)),
      stops: transit.route.stops
    } : null
  });
  for (const v of ventures) {
    const template = VENTURE_TEMPLATES.find(t => v.id.endsWith(`:${t.id}`) && v.placeId === t.placeId && v.label === t.label && v.steps.length === t.steps.length && v.steps.every((s, i) => s.id === t.steps[i]!.id && s.label === t.steps[i]!.label && s.durationMinutes === t.steps[i]!.durationMinutes && publicCanonicalJson(s.requires) === publicCanonicalJson(t.steps[i]!.requires)));
    const quantities = (items: typeof v.steps[number]['requires']) => items.map(q => ({
      material: q.resourceId,
      quantity: q.quantity
    }));
    emit('venture.state', [ref('venture', v.id), ref('place', v.placeId), ref('resident', v.proposerId)], {
      labelKey: template?.id ?? 'unavailable',
      status: v.status,
      proposedMinute: v.proposedMinute,
      consentDeadlineMinute: v.consentDeadlineMinute,
      deadlineMinute: v.deadlineMinute,
      steps: v.steps.map((s, i) => ({
        ordinal: i,
        labelKey: template ? s.id : 'unavailable',
        durationMinutes: s.durationMinutes,
        requires: quantities(s.requires),
        status: s.status,
        startedMinute: s.startedMinute,
        completedMinute: s.completedMinute,
        consumed: quantities(s.consumed)
      })),
      participants: v.participants.map(p => ({
        resident: ref('resident', p.residentId),
        consent: p.consent,
        invitedMinute: p.invitedMinute,
        respondedMinute: p.respondedMinute
      })),
      outcome: v.outcome ? {
        minute: v.outcome.minute,
        result: v.outcome.result,
        reason: v.outcome.reason
      } : null
    });
    const totals = (material: string) => {
      const ledger = state.life?.ventures?.resources[material];
      return {
        reserved: (ledger?.active ?? []).filter(r => r.planId === v.id && r.status === 'active').reduce((n, r) => n + r.quantity, 0),
        consumed: v.steps.flatMap(s => s.consumed).filter(q => q.resourceId === material).reduce((n, q) => n + q.quantity, 0)
      };
    };
    emit('venture.materials', [ref('venture', v.id)], {
      minute: state.canonicalMinute,
      timber: totals('timber'),
      stone: totals('stone')
    });
  }
  for (const c of Object.values(state.life?.charts ?? {})) emit('place.survey', [ref('place', c.placeId), ref('resident', c.surveyorId)], {
    surveyedMinute: c.surveyedMinute,
    present: c.present,
    seen: c.seen.map(id => ref('resident', id)),
    projects: c.projects.map(p => ({
      project: ref('project', p.projectId),
      progress: p.progress
    }))
  });
  // Evidence is derived and drained once, including observations whose readings eventually
  // leave the presentation window. Inventory admission above is complete before this phase:
  // ref() only validates/looks up and never allocates. Repeated successful references therefore
  // have no effects. Keep their first use in ORIGINAL resident/observation/project-before-place
  // order; one earliest missing reference is enough to preserve the first refusal exactly.
  const measurementResidents = Object.values(state.residents);
  const residentOrder = new Map(measurementResidents.map((r, i) => [r.id, i]));
  type ReferenceUse = { kind: 'project' | 'place'; id: string; resident: number; ordinal: number; slot: number };
  const compareUse = (a: ReferenceUse, b: ReferenceUse) => a.resident - b.resident || a.ordinal - b.ordinal || a.slot - b.slot;
  const firstUses = new Map<string, ReferenceUse>();
  let missing: ReferenceUse | undefined;
  const observations = new Map<string, { ordinal: number; tail: VerifiedPublicObservation[] }>();
  for (const e of evidence) {
    const resident = residentOrder.get(e.residentId);
    if (resident === undefined) continue; // Same absent-resident filtering as the original loop.
    let observed = observations.get(e.residentId);
    if (!observed) { observed = { ordinal: 0, tail: [] }; observations.set(e.residentId, observed); }
    const ordinal = observed.ordinal++;
    if (!Number.isSafeInteger(observed.ordinal)) throw new Error('public observation ordinal bound');
    for (const [kind, id, slot] of [['project', e.projectId, 0], ['place', e.placeId, 1]] as const) {
      const use: ReferenceUse = { kind, id, resident, ordinal, slot };
      if (!current.get(kind)?.has(id)) {
        if (!missing || compareUse(use, missing) < 0) missing = use;
      } else {
        const key = `${kind}:${id}`, prior = firstUses.get(key);
        if (!prior || compareUse(use, prior) < 0) firstUses.set(key, use);
      }
    }
    // This is the existing last16 presentation operation, after retaining ALL reference effects.
    // Bounds: <=512 canonical residents *16 readings, <=30000 admitted first-use refs +1 refusal.
    observed.tail.push({ ...e });
    if (observed.tail.length > 16) observed.tail.shift();
  }
  if (firstUses.size > registry.entries.length) throw new Error('public reference metadata bound');
  const uses = [...firstUses.values(), ...(missing ? [missing] : [])].sort(compareUse);
  let nextUse = 0;
  for (let index = 0; index < measurementResidents.length; index++) {
    const r = measurementResidents[index]!, rr = ref('resident', measurementResidents[index]!.id);
    while (uses[nextUse]?.resident === index) {
      const use = uses[nextUse++]!;
      ref(use.kind, use.id);
    }
    const prior = previous?.facts.find(f => f.code === 'resident.measurements' && f.subjects[0].id === rr.id);
    const readings = prior?.code === 'resident.measurements' ? [...prior.values.readings] : [];
    for (const e of observations.get(r.id)?.tail ?? []) readings.push({
      minute: e.minute,
      project: ref('project', e.projectId),
      place: ref('place', e.placeId),
      value: e.value,
      evidenceKind: e.evidenceKind
    });
    if (readings.length) emit('resident.measurements', [rr], {
      readings: readings.slice(-16)
    });
  }
  if (invention) {
    for(const g of Object.values(invention.grants)){const m=g.method;if(!m)continue;const l=m.lessons.at(-1);emit('grant.state',[ref('grant',g.id),ref('resident',g.teacherId),ref('resident',g.learnerId),ref('workpad',invention.designs[g.designId]!.input.site)],{revision:g.revision,status:g.status,expiresMinute:g.expiresMinute,method:ref('method',m.methodVersionId),artifact:ref('artifact',m.teacherArtifactId),trial:ref('trial',g.trialId),accepted:m.acceptance!==null,lesson:l?.status??'none',startedMinute:l?.startedMinute??null,endedMinute:l?.endedMinute??null,executions:m.executions.length,latestPassed:m.executions.at(-1)?.test.passed??null,latestExecutionAuthority:m.executions.at(-1)?.executionAuthority??null,reproductionArtifact:g.reproductionArtifactId?ref('artifact',g.reproductionArtifactId):null,reproductionTrial:g.reproductionTrialId?ref('trial',g.reproductionTrialId):null});}
    for (const x of Object.values(invention.methods ?? {})) emit('method.state', [ref('method', x.id), ref('resident', x.authorId), ref('agenda', x.origin.agendaId), ref('workpad', x.origin.context.site)], {
      revision: x.revision,
      state: x.applicability.state,
      reason: x.applicability.reason,
      passed: x.tests.some(t => t.hash === x.selectedReceiptHash && t.passed),
      authority: x.authority.kind,
      admittedMinute: x.admittedMinute
    });
    for (const x of Object.values(invention.sites)) emit('workpad.state', [ref('workpad', x.id), ref('place', x.placeId)], {
      revision: x.revision,
      capacity: x.capacity,
      access: x.access
    });
    for (const x of Object.values(invention.agendas)) emit('agenda.state', [ref('agenda', x.id), ref('resident', x.ownerId), ref('workpad', x.siteId)], {
      revision: x.revision,
      stage: x.stage,
      need: x.needTrialId ? ref('trial', x.needTrialId) : null,
      candidates: x.candidateIds.map(id => ref('design', id)),
      selected: x.selectedDesignId ? ref('design', x.selectedDesignId) : null,
      consultation: x.consultationId ? ref('consultation', x.consultationId) : null,
      trials: x.trialIds.map(id => ref('trial', id)),
      blocked: x.blocked,
      continuation: x.continuation?.kind ?? null,
      continuationStatus: x.continuation?.status ?? null
    });
    for (const x of Object.values(invention.consultations)) emit('consultation.state', [ref('consultation', x.id), ref('resident', x.requesterId), ref('resident', x.peerId), ref('workpad', x.siteId)], {
      revision: x.revision,
      need: ref('trial', x.needTrialId),
      status: x.status,
      question: x.question,
      createdMinute: x.createdMinute,
      expiresMinute: x.expiresMinute,
      suggest: x.answer?.suggest ?? null,
      certainty: x.answer?.certainty ?? null,
      sources: x.answer?.sourceTrialIds.map(id => ref('trial', id)) ?? []
    });
    for (const x of Object.values(invention.designs)) emit('design.state', [ref('design', x.id), ref('resident', x.authorId), ref('workpad', x.input.site)], {
      need: ref('trial', x.input.need),
      parent: x.input.parent ? ref('design', x.input.parent) : null,
      parts: x.input.parts,
      claim: x.input.claim,
      ...x.bom,
      buildMinutes: x.buildMinutes,
      status: x.status
    });
    for (const x of Object.values(invention.artifacts)) emit('artifact.state', [ref('artifact', x.id), ref('design', x.designId), ref('resident', x.ownerId), ref('workpad', x.siteId)], {
      revision: x.revision,
      condition: x.condition,
      access: x.access,
      slot: x.slot,
      completedMinute: x.completedMinute
    });
    for (const x of Object.values(invention.trials)) emit('trial.state', [ref('trial', x.id), ref('resident', x.actorId), ref('workpad', x.siteId)], {
      design: x.designId ? ref('design', x.designId) : null,
      artifact: x.artifactId ? ref('artifact', x.artifactId) : null,
      mode: x.mode,
      purpose: x.purpose,
      ...x.operation,
      buildingSkill: x.buildingSkill,
      startingCondition: x.startingCondition,
      startedMinute: x.startedMinute,
      endedMinute: x.endedMinute,
      outcome: x.outcome,
      quality: x.quality,
      duration: x.duration,
      ...x.consumed,
      claimVerdict: x.claimVerdict,
      comparison: x.comparisonTrialId ? ref('trial', x.comparisonTrialId) : null,
      useful: x.useful
    });
    for (const x of Object.values(invention.jobs)) emit('assembly-job.state', [ref('assembly-job', x.id), ref('resident', x.actorId), ref('workpad', x.siteId)], {
      artifact: x.artifactId ? ref('artifact', x.artifactId) : null,
      status: x.status,
      result: x.resultTrialId ? ref('trial', x.resultTrialId) : null,
      operation: x.operation,
      purpose: x.purpose
    });
  }
  if (policy === 2 && capabilities.residentAffordances !== false) for (const id of Object.keys(state.life?.residents ?? {})) emit('resident.affordances', [ref('resident', id)], admitResidentAffordances(state, id, ref));
  facts.sort((a, b) => publicKeyString(publicFactKey(a)) < publicKeyString(publicFactKey(b)) ? -1 : publicKeyString(publicFactKey(a)) > publicKeyString(publicFactKey(b)) ? 1 : 0);
  return {
    minute: state.canonicalMinute,
    facts
  } as ApprovedPublicFacts;
}
export function projectPublicSnapshot(input: ApprovedPublicFacts, streamId: string, cursor: number): PublicSnapshot {
  const admitted = ApprovedPublicFactsSchema.parse(input);
  return PublicSnapshotSchema.parse({
    schemaVersion: 1,
    catalogueVersion: 1,
    streamId,
    cursor,
    revision: publicRevision(admitted),
    minute: admitted.minute,
    facts: admitted.facts
  });
}
export function createPublicBaseline(state: WorldState, registry: AdmissionRegistry, streamId: string, policy: PublicProjectionPolicy = 2, capabilities: PublicProjectionCapabilities = {}): PublicSnapshot {
  return projectPublicSnapshot(approveCanonicalWorld(state, registry, undefined, [], policy, capabilities), streamId, 0);
}
export function derivePublicCommit(previous: PublicSnapshot, state: WorldState, registry: AdmissionRegistry, evidence: Iterable<VerifiedPublicObservation> = [], policy: PublicProjectionPolicy = 2, capabilities: PublicProjectionCapabilities = {}): {
  snapshot: PublicSnapshot;
  event?: PublicEvent;
} {
  const approved = approveCanonicalWorld(state, registry, previous, evidence, policy, capabilities),
    next = projectPublicSnapshot(approved, previous.streamId, previous.cursor);
  if (next.revision === previous.revision) return {
    snapshot: previous
  };
  const before = new Map(previous.facts.map(f => [publicKeyString(publicFactKey(f)), f])),
    after = new Map(next.facts.map(f => [publicKeyString(publicFactKey(f)), f]));
  const operations: PublicEvent['operations'] = [];
  for (const [key, f] of before) if (!after.has(key)) operations.push({
    op: 'remove',
    key: publicFactKey(f)
  });
  for (const [key, f] of after) if (publicCanonicalJson(before.get(key) ?? null) !== publicCanonicalJson(f)) operations.push({
    op: 'put',
    fact: f
  });
  const event = PublicEventSchema.parse({
    schemaVersion: 1,
    streamId: previous.streamId,
    cursor: previous.cursor + 1,
    previousRevision: previous.revision,
    revision: next.revision,
    minute: next.minute,
    operations
  });
  next.cursor = event.cursor;
  return {
    snapshot: next,
    event
  };
}
