import { cognitionActionPriority, inventionAffordances } from './invention-affordances.js';
import { planResidentTravel, chooseSocialVenue, VENTURE_TEMPLATES, storesCanSupply, surveyTargets, frontierMenu, homesToMoveInto, FRONTIER_WORK_PLACE_ID, wardrobeChoiceOrder, wardrobeChoices, wardrobeMenu, type WardrobeChoice } from '@meridian/world-kernel';
import { PUBLIC_AFFORDANCE_LIMIT, publicCanonicalJson } from '@meridian/world-schema';
import type { WorldState, PublicRef, PublicKind, PublicAffordance } from '@meridian/world-schema';

type WardrobeAffordance = Extract<PublicAffordance, { code: 'choose-appearance' }>;
/** The actor's own appearance change, as a public choice. It names no other resident. */
export const wardrobeAffordance = (choice: WardrobeChoice): WardrobeAffordance => ({ code: 'choose-appearance', [choice.slot]: choice.value }) as WardrobeAffordance;
export function wardrobeChoiceOf(action: WardrobeAffordance): WardrobeChoice {
  for (const slot of ['look', 'hairStyle', 'garment', 'trousers', 'footwear', 'accessory'] as const) {
    const value = action[slot];
    if (value !== undefined) return { slot, value } as WardrobeChoice;
  }
  throw new Error('appearance choice names no change');
}
/** Wardrobe choices always follow every ordinary choice, in the fixed wardrobe order. */
export const wardrobeRank = (action: PublicAffordance): number => action.code === 'choose-appearance' ? 1 + wardrobeChoiceOrder(wardrobeChoiceOf(action)) : 0;

/** Admission reads typed mechanics only. Never reads goals, memory, trust, corpus or option prose.
 * Own task occupancy is deliberately omitted: these are available future plans, revalidated on execution.
 * Selectors here read canonical numeric/structural mechanics, never the private decision menu.
 */
export function admitResidentAffordances(state: WorldState, id: string, ref: (kind: PublicKind, id: string) => PublicRef, focusedResidentIds: readonly string[] = []): { actions: PublicAffordance[]; omittedActions: number } {
  const life = state.life, p = life?.residents[id], r = state.residents[id];
  if (!life || !p || !r) return { actions: [], omittedActions: 0 };
  if (focusedResidentIds.length > 20) throw new RangeError('at most20 focused cognition residents');
  const focusedPeers = new Set(focusedResidentIds.filter(peer=>state.residents[peer] && state.residents[peer]!.lifeStage !== 'child').map(peer=>ref('resident',peer).id));
  const typed = <K extends PublicKind>(kind: K, id: string) => ref(kind, id) as { kind: K; id: number };
  // Keep only the first public-field-ordered page throughout generation, not after serialization.
  const kept: { action: PublicAffordance; key: string }[] = [];
  let total = 0;
  const count = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(total + n)) throw new RangeError('affordance count exceeds safe integer');
    total += n;
  };
  const keep = (action: PublicAffordance) => {
    let priority = life.invention ? cognitionActionPriority(action) : 0;
    if (life.invention && action.code === 'invention' && ['consult','offer-method'].includes(action.intent) && action.peer && focusedPeers.has(action.peer.id)) priority = 1;
    const key = action.code === 'choose-appearance' ? `9:${String(wardrobeRank(action)).padStart(3, '0')}` : `${priority}:${publicCanonicalJson(action)}`;
    if (kept.length === PUBLIC_AFFORDANCE_LIMIT && key.localeCompare(kept.at(-1)!.key) >= 0) return;
    kept.push({ action, key });
    kept.sort((a, b) => a.key.localeCompare(b.key));
    if (kept.length > PUBLIC_AFFORDANCE_LIMIT) kept.pop();
  };
  const offer = (...candidates: PublicAffordance[]) => { count(candidates.length); for (const action of candidates) keep(action); };
  const finish = () => ({ actions: kept.map(v => v.action), omittedActions: total - kept.length });
  offer({ code: 'rest' });
  // The resident's own wardrobe, once opened: the kernel's bounded rail, with every legal choice the rail
  // does not show counted as an honest omission. Children's choices hold only age-appropriate clothing.
  const wardrobe = wardrobeMenu(state, id).map(wardrobeAffordance);
  const offerWardrobe = () => { count(wardrobeChoices(state, id).length - wardrobe.length); offer(...wardrobe); };
  if (r.lifeStage === 'child') { offerWardrobe(); return finish(); }
  offer({ code: 'think' });
  offer(...inventionAffordances(state,id,ref).filter(a=>p.task?.kind!=="frontier-return"||a.code==="invention"&&["accept-method","decline-method","revoke-method","invite-lesson","accept","decline","answer","withdraw-consultation"].includes(a.intent)));
  const energy = p.needs.energy;
  // Pure structural reach, including future plans while busy; no private option labels or occupied-task edits.
  const reachable = (placeId: string, actor = id) => !life.transit || planResidentTravel(state, actor, placeId, state.canonicalMinute + 1) !== undefined;
  const meeting = (other: string) => {const both=(place:string)=>reachable(place)&&reachable(place,other);return both(chooseSocialVenue(state,id,other,state.canonicalMinute+1,both));};
  if (energy >= 20 && p.skills.work > 0 && reachable(r.workPlaceId)) offer({ code: 'work' });
  for (const c of Object.values(life.commitments)) {
    if (c.lenderId === id && c.status === 'pending' && c.expiresMinute > state.canonicalMinute + 1) {
      offer({ code: 'decline-request', commitment: typed('commitment', c.id) });
      if (energy >= 15 && reachable(c.placeId) && reachable(c.placeId,c.requesterId) && life.residents[c.requesterId]?.task?.commitmentId === c.id && life.resources[c.resourceId]?.ownerId === id) offer({ code: 'accept-request', commitment: typed('commitment', c.id) });
    }
    if (c.requesterId === id && c.status === 'loaned' && reachable(c.placeId) && reachable(c.placeId,c.lenderId) && life.resources[c.resourceId]?.ownerId === id && !life.residents[c.lenderId]?.task && energy >= 10 && life.residents[c.lenderId]!.needs.energy >= 10) offer({ code: 'return-tool', commitment: typed('commitment', c.id) });
  }
  if (energy >= 20 && p.skills.gardening >= 40) {
    // Count the complete legal Cartesian product arithmetically. Retain at most128 refs
    // per axis/category, then materialize at most128 candidates per action code.
    const projects: { kind: 'project'; id: number }[] = [];
    const owned: { kind: 'object'; id: number }[] = [], borrowed: typeof owned = [];
    let projectCount = 0, ownedCount = 0, borrowedCount = 0;
    const keepRef = <T extends PublicRef>(items: T[], value: T) => {
      items.push(value);
      items.sort((a, b) => publicCanonicalJson(a).localeCompare(publicCanonicalJson(b)));
      if (items.length > PUBLIC_AFFORDANCE_LIMIT) items.pop();
    };
    for (const project of Object.values(life.projects)) if (project.kind === 'garden' && project.progress < 100 && reachable(project.placeId)) {
      projectCount++;
      keepRef(projects, typed('project', project.id));
    }
    const active = new Set(Object.values(life.commitments).filter(c => ['pending', 'meeting', 'loaned', 'returning'].includes(c.status)).map(c => c.resourceId));
    for (const object of Object.values(life.resources)) {
      if (object.ownerId === id) { ownedCount++; keepRef(owned, typed('object', object.id)); }
      else if (!active.has(object.id) && reachable('founders-square')) { borrowedCount++; keepRef(borrowed, typed('object', object.id)); }
    }
    count(projectCount * ownedCount);
    count(projectCount * borrowedCount);
    for (const [code, objects] of [['use-tool', owned], ['request-tool', borrowed]] as const) {
      let generated = 0;
      outer: for (const object of objects) for (const project of projects) {
        keep({ code, object, project });
        if (++generated === PUBLIC_AFFORDANCE_LIMIT) break outer;
      }
    }
  }
  // Exact engine-authored occupation vocabulary only; arbitrary occupation prose is never forwarded.
  const cartographer = p.skills.occupation === 'Cartographer';
  // The kernel's own frontier selectors: under frontier access policy 1, only worksites this resident can reach.
  const frontier = frontierMenu(state, id);
  if (energy >= 20 && cartographer) {
    for (const place of surveyTargets(state, id).filter(place=>reachable(place))) offer({ code: 'survey', place: typed('place', place) });
    if (Object.hasOwn(state.places, FRONTIER_WORK_PLACE_ID)) for (const parcel of frontier.chartTargets()) offer({ code: 'chart-frontier', parcel: typed('parcel', parcel.id) });
  }
  if (energy >= 30 && Object.hasOwn(state.places, FRONTIER_WORK_PLACE_ID)) {
    const parcel = frontier.helpTargets().find(p => !(cartographer && frontier.chartTargets().some(t => t.id === p.id)));
    if (parcel) offer({ code: 'help-chart', parcel: typed('parcel', parcel.id) });
    for (const { parcel, spec } of frontier.foundingOptions()) offer({ code: 'found-place', parcel: typed('parcel', parcel.id), buildKind: spec.kind });
    for (const home of homesToMoveInto(state, id).filter(home=>reachable(home.placeId)).slice(0, 2)) offer({ code: 'move-home', place: typed('place', home.placeId) });
    const build = frontier.buildSite();
    if (build) offer({ code: 'build', parcel: typed('parcel', build.id) });
  }
  if (energy >= 10) {
    const partner = Object.keys(life.residents).sort().find(other => other !== id && state.residents[other]?.lifeStage !== 'child' && !life.residents[other]!.task && life.residents[other]!.needs.energy >= 10 && meeting(other));
    if (partner) offer({ code: 'socialise', resident: typed('resident', partner) });
  }
  if (life.ventures) {
    const open = Object.values(life.ventures.projects);
    for (const venture of open) if (venture.participants.find(p => p.residentId === id)?.consent === 'invited' && state.canonicalMinute + 1 < venture.consentDeadlineMinute) {
      if(reachable(venture.placeId))offer({code:'join-venture',venture:typed('venture',venture.id)});
      offer({code:'decline-venture',venture:typed('venture',venture.id)});
    }
    if (!open.some(v => v.proposerId === id) && open.length < 2 && energy >= 30) for (const t of VENTURE_TEMPLATES) {
      const project = life.projects[t.consequence.projectId];
      if (!state.places[t.placeId] || !reachable(t.placeId) || !project || project.progress >= 100 || !storesCanSupply(life, t.steps)) continue;
      if (!('cooldownMinutes' in t)) { if (p.needs.purpose >= 70) continue; }
      else if (open.some(v => v.id.endsWith(`:${t.id}`)) || life.ventures.retired.some(v => v.id.endsWith(`:${t.id}`) && v.outcome && state.canonicalMinute - v.outcome.minute < t.cooldownMinutes)) continue;
      offer({ code: 'propose-venture', template: t.id });
    }
  }
  offerWardrobe();
  return finish();
}
