import type { ResidentRenderProfile } from "./resident-appearance.js";
import { residentCityPosition, isWithinPlaceFrontage, type CityBuilding } from "./city-layout.js";
import { createPedestrianMap, isConnectedPosition, nearestConnectedPosition, residentRig } from "./pedestrian-path.js";
import type { ResidentVisualState } from "./projection-visuals.js";
import { frontierWorksitePosition } from "./frontier-visuals.js";

type Foot = [number, number, number];
const paired = new Set(["handover", "return-tool", "socialise"]);

/** Reciprocal canonical meetings share a nearby visible pair of safe exterior locators. */
export function interactionPositions(residents: readonly ResidentVisualState[], buildings: readonly CityBuilding[]): Foot[] {
  // A frontier shift is drawn at its public worksite only once the engine has the resident there (phase "working").
  // Still travelling, they are where the engine has them, at the place they set out from: no early arrival on screen.
  const atWorksite = (r: ResidentVisualState) => (r.frontierSite?.phase === "working" || r.frontierSite?.phase === "returning") ? r.frontierSite : undefined;
  const positions = residents.map((r) => { const site = atWorksite(r); return site ? frontierWorksitePosition(site, r.id) : residentCityPosition(r.placeId, r.id, buildings); });
  const index = new Map(residents.map((r, i) => [r.id, i]));
  const map = createPedestrianMap(buildings);
  const assigned = new Set<number>();
  const occupied: Foot[] = [];
  const available = (point: Foot, placeId: string) => isWithinPlaceFrontage(placeId,point)
    && isConnectedPosition(map,point) && occupied.every(p=>Math.hypot(p[0]-point[0],p[2]-point[2])>.75);
  const candidates = (anchor: Foot, placeId: string): Foot[] => {
    const result = [anchor];
    for(let radius=.95;radius<=12;radius+=.95) for(let direction=0;direction<32;direction++) {
      const angle=direction*Math.PI/16;
      const point: Foot = [anchor[0]+Math.cos(angle)*radius,anchor[1],anchor[2]+Math.sin(angle)*radius];
      if(isWithinPlaceFrontage(placeId,point)) result.push(point);
    }
    return result;
  };
  // Canonical ID order keeps locators stable when the projection array is reordered.
  for (const [i, resident] of [...residents.entries()].sort((a,b)=>a[1].id.localeCompare(b[1].id))) {
    if(assigned.has(i)) continue;
    // Worksites lie outside every place frontage: quay paving (kept on the walkable network) or charted ground.
    const site = atWorksite(resident);
    if(site) {
      if(site.kind === "quay") positions[i] = nearestConnectedPosition(map, positions[i]!);
      assigned.add(i); occupied.push(positions[i]!); continue;
    }
    const j = resident.partnerId ? index.get(resident.partnerId) : undefined;
    const partner = j === undefined ? undefined : residents[j];
    const meeting = j !== undefined && !assigned.has(j) && paired.has(resident.taskKind ?? "")
      && partner?.partnerId === resident.id && partner.placeId === resident.placeId && partner.taskKind === resident.taskKind;
    let placed = false;
    for (const anchor of candidates(positions[i]!,resident.placeId)) {
      if(!available(anchor,resident.placeId)) continue;
      if(meeting) {
        for(let direction=0;direction<16;direction++) {
          const angle=direction*Math.PI/8;
          const second: Foot = [anchor[0]+Math.cos(angle)*1.1,anchor[1],anchor[2]+Math.sin(angle)*1.1];
          if(!available(second,resident.placeId)) continue;
          positions[i]=[...anchor]; positions[j!]=second;
          assigned.add(i); assigned.add(j!); occupied.push(positions[i]!,second); placed=true; break;
        }
      } else { positions[i]=[...anchor]; assigned.add(i); occupied.push(positions[i]!); placed=true; }
      if(placed) break;
    }
    // If an unusually dense scene has no room, preserve its real place locator.
    if(!placed) { assigned.add(i); occupied.push(positions[i]!); }
  }
  return positions;
}

export function gardenGrowthCount(progress: number): number {
  return Math.floor(Math.min(100, Math.max(0, Number.isFinite(progress) ? progress : 0)) * .4);
}

/**
 * Observable work/meeting gesture as arm pitch; feet and legs stay grounded.
 * Hands follow the arms because the rig derives them from the same angles.
 */
export function activityPose(foot: Foot, heading: number, phase: number, taskKind: string | undefined, build = 1, hair: "cropped" | "full" | "tied" = "full", look?: ResidentRenderProfile) {
  let arms: [number, number] = [0, 0];
  if (paired.has(taskKind ?? "")) arms = [-.65 + Math.sin(phase) * .12, -.45];
  else if (taskKind === "use-tool") { const swing = -.85 + Math.sin(phase * 1.3) * .25; arms = [swing, swing]; }
  return residentRig(foot, heading, 0, arms, build, hair, look);
}
