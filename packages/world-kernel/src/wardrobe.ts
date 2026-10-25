import {
  WARDROBE_LOOKS, WorldEventSchema, WorldStateSchema, assertOriginalPresentations, resolveResidentPresentation, sameResidentPresentation, type OriginalPresentations,
  type AccessoryId, type FootwearId, type GarmentId, type HairStyleId, type ResidentAppearanceProfile, type ResidentState, type TrouserId,
  type WardrobeLookId, type WorldEvent, type WorldState,
} from "@meridian/world-schema";
import { ACCESSORIES, FOOTWEAR, GARMENTS, HAIR_STYLES, TROUSERS } from "./resident-appearance.js";

/**
 * The owned wardrobe (Transport Ruling: owned appearance choice must be actual resident selection and
 * persistence). A resident may change only their own presentation, at home, from a closed catalogue:
 * the packaged adult looks and the existing clothing lists. Children get clothing only, never an adult
 * look. Fixed traits never change. The engine never chooses for anyone; only the resident's own
 * (model) decision is accepted. Nothing here exists until the wardrobe is explicitly opened.
 */
export const WARDROBE_COOLDOWN_MINUTES = 60;
export const WARDROBE_OPTION_PREFIX = "appearance:";
/**
 * At most this many wardrobe choices appear in one decision menu, so the wardrobe never crowds a resident's
 * ordinary choices or enlarges a prompt by more than a few entries. Rights are not narrowed: every legal
 * choice stays acceptable (`legalWardrobeChoice`); the future menu shows a rotating rail of supported changes.
 */
export const WARDROBE_MENU_LIMIT = 6;
/** The future menu's rail turns once per this many canonical minutes, so every offered change comes round. */
export const WARDROBE_ROTATION_MINUTES = 60;

export type WardrobeChoice =
  | { slot: "look"; value: WardrobeLookId | "original" }
  | { slot: "hairStyle"; value: HairStyleId }
  | { slot: "garment"; value: GarmentId }
  | { slot: "trousers"; value: TrouserId }
  | { slot: "footwear"; value: FootwearId }
  | { slot: "accessory"; value: AccessoryId };
type Slot = WardrobeChoice["slot"];

const STYLED_LOOKS = WARDROBE_LOOKS.slice(0, 4);
const EVERYDAY_LOOKS = WARDROBE_LOOKS.slice(4);
const choices = <S extends Slot>(slot: S, values: readonly string[]) => values.map((value) => ({ slot, value }) as WardrobeChoice);
/**
 * One fixed presentation order for every resident: the way back, styled looks, the most visible
 * clothing, then everyday looks. A truncated menu therefore keeps the most distinct choices.
 */
const ORDER: readonly WardrobeChoice[] = [
  { slot: "look", value: "original" },
  ...choices("look", STYLED_LOOKS),
  ...choices("garment", GARMENTS), ...choices("accessory", ACCESSORIES), ...choices("hairStyle", HAIR_STYLES),
  ...choices("look", EVERYDAY_LOOKS),
  ...choices("trousers", TROUSERS), ...choices("footwear", FOOTWEAR),
];
const ORDER_INDEX = new Map(ORDER.map((choice, index) => [`${choice.slot}:${choice.value}`, index]));
/** Age-appropriate for children: clothing and hair only. No adult look, no accessories (the child rig shows none). */
const CHILD_SLOTS: ReadonlySet<Slot> = new Set(["hairStyle", "garment", "trousers", "footwear"]);

export const wardrobeOptionId = (choice: WardrobeChoice): string => `${WARDROBE_OPTION_PREFIX}${choice.slot}:${choice.value}`;
export const wardrobeChoiceOrder = (choice: WardrobeChoice): number => ORDER_INDEX.get(`${choice.slot}:${choice.value}`) ?? ORDER.length;

export function parseWardrobeOptionId(optionId: string): WardrobeChoice | undefined {
  if (!optionId.startsWith(WARDROBE_OPTION_PREFIX)) return undefined;
  const [slot, value, ...rest] = optionId.slice(WARDROBE_OPTION_PREFIX.length).split(":");
  if (rest.length || slot === undefined || value === undefined || !ORDER_INDEX.has(`${slot}:${value}`)) return undefined;
  return { slot, value } as WardrobeChoice;
}

const title = (value: string) => value.replaceAll("-", " ");
export function wardrobeOptionLabel(choice: WardrobeChoice): string {
  switch (choice.slot) {
    case "look": return choice.value === "original" ? "Go back to my original look" : `Change into the ${title(choice.value)} look`;
    case "hairStyle": return `Wear my hair ${title(choice.value)}`;
    case "garment": return `Change into ${title(choice.value)}`;
    case "trousers": return `Change into ${title(choice.value)}`;
    case "footwear": return `Change into ${title(choice.value)}`;
    case "accessory": return choice.value === "none" ? "Take off my accessory" : `Wear a ${title(choice.value)}`;
  }
}

/** Is this choice open to this resident's life stage at all (independent of where they are)? */
export const wardrobeChoiceAllowed = (choice: WardrobeChoice, child: boolean): boolean => !child || CHILD_SLOTS.has(choice.slot);

/**
 * Her cooldown is over at this minute: no change within WARDROBE_COOLDOWN_MINUTES of her last recorded one,
 * whoever recorded it (a legacy record counts too). The menu and replay both use this one rule.
 */
export const wardrobeCooldownOver = (appearance: ResidentAppearanceProfile, minute: number): boolean =>
  !appearance.latestChange || minute - appearance.latestChange.minute >= WARDROBE_COOLDOWN_MINUTES;

/** A real change of what she wears: never her current value, and the way back only while a chosen look is worn. */
export function wardrobeChoiceChanges(appearance: ResidentAppearanceProfile, choice: WardrobeChoice): boolean {
  const current = appearance.presentation;
  if (choice.slot === "look") return choice.value === "original" ? current.look !== undefined : current.look !== choice.value;
  return current[choice.slot] !== choice.value;
}

/**
 * The resident's own wardrobe choices now, in fixed order: only in an opened wardrobe, only at their own
 * home, not again within the cooldown, never their current value. Reads canonical structure only.
 */
export function wardrobeChoices(state: WorldState, residentId: string): WardrobeChoice[] {
  const life = state.life;
  if (!life?.wardrobe || !Object.hasOwn(life.residents, residentId) || !Object.hasOwn(state.residents, residentId)) return [];
  const resident = state.residents[residentId]!;
  const appearance = life.residents[residentId]!.appearance;
  if (!appearance || resident.placeId !== resident.homePlaceId) return [];
  // A choice takes effect in the next canonical minute; replay checks the same rules at that minute.
  if (!wardrobeCooldownOver(appearance, state.canonicalMinute + 1)) return [];
  const child = resident.lifeStage === "child";
  return ORDER.filter((choice) => wardrobeChoiceAllowed(choice, child) && wardrobeChoiceChanges(appearance, choice));
}

const isOriginal = (choice: WardrobeChoice) => choice.slot === "look" && choice.value === "original";

/**
 * The bounded wardrobe menu now: at most WARDROBE_MENU_LIMIT legal choices, in fixed order. The way back to
 * a visibly different original is shown while a chosen look is worn. Adults are offered whole looks only:
 * the imported adult models cannot display individual clothing-slot changes. Children keep their supported
 * procedural clothing. The rail turns every WARDROBE_ROTATION_MINUTES so all offered changes come round.
 * Historical full-slot legality, replay and cooldown rights remain unchanged outside this future menu.
 */
export function wardrobeMenu(state: WorldState, residentId: string): WardrobeChoice[] {
  const child = state.residents[residentId]?.lifeStage === "child";
  const original = state.life?.wardrobe?.originals?.[residentId];
  // Old unbound worlds keep their history and full rights; unknown adult rendering earns no future offer.
  if (!child && !original) return [];
  const current = resolveResidentPresentation(state.life?.residents[residentId]?.appearance, original);
  const legal = wardrobeChoices(state, residentId).filter(choice => child || choice.slot === "look" && current && !sameResidentPresentation(choice.value === "original" ? original! : { kind: "catalogue", look: choice.value }, current));
  if (legal.length <= WARDROBE_MENU_LIMIT) return legal;
  const back = legal.filter(isOriginal), rail = legal.filter((choice) => !isOriginal(choice));
  const size = WARDROBE_MENU_LIMIT - back.length;
  const start = (Math.floor(state.canonicalMinute / WARDROBE_ROTATION_MINUTES) * size) % rail.length;
  const shown = new Set(Array.from({ length: size }, (_, offset) => rail[(start + offset) % rail.length]!));
  return [...back, ...rail.filter((choice) => shown.has(choice))];
}

/**
 * The resident's legal wardrobe choice named by this option id, whether or not the rail shows it now (a choice
 * planned while busy survives the rail turning). Undefined when it is not a legal wardrobe choice for them.
 */
export function legalWardrobeChoice(state: WorldState, residentId: string, optionId: string): WardrobeChoice | undefined {
  const choice = parseWardrobeOptionId(optionId);
  return choice && wardrobeChoices(state, residentId).some((legal) => legal.slot === choice.slot && legal.value === choice.value) ? choice : undefined;
}

/** The resident's appearance after their own choice. Fixed traits are never touched. */
export function applyWardrobeChoice(appearance: ResidentAppearanceProfile, choice: WardrobeChoice, minute: number): ResidentAppearanceProfile {
  const next = structuredClone(appearance);
  if (choice.slot === "look") {
    if (choice.value === "original") delete next.presentation.look;
    else next.presentation.look = choice.value;
  } else (next.presentation as Record<string, string>)[choice.slot] = choice.value;
  next.latestChange = { minute, decisionId: wardrobeOptionId(choice), source: "resident" };
  return next;
}

/** One-time zero-minute cutover. Returns the state unchanged when not applicable or already open. */
export function openWardrobe(input: WorldState, originals?: OriginalPresentations): { state: WorldState; event?: Extract<WorldEvent, { type: "wardrobe-opened" }> } {
  const verified = WorldStateSchema.parse(input);
  if (!verified.life || verified.life.wardrobe) return { state: verified };
  const state = structuredClone(verified);
  if (originals) assertOriginalPresentations(verified.residents, originals);
  const wardrobe = { catalogueVersion: 1 as const, ...(originals ? { originals: structuredClone(originals) } : {}) };
  state.life!.wardrobe = wardrobe;
  const event = WorldEventSchema.parse({ type: "wardrobe-opened", minute: state.canonicalMinute, wardrobe }) as Extract<WorldEvent, { type: "wardrobe-opened" }>;
  return { state: WorldStateSchema.parse(state), event };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));

type ResidentLifeChanged = Extract<WorldEvent, { type: "resident-life-changed" }>;
type Standing = Pick<ResidentState, "placeId" | "homePlaceId" | "lifeStage">;

/**
 * Where a resident stood, where her home was and her life stage at `events[index]`: the committed result with
 * the minute's later recorded moves reversed. Undefined when she did not exist yet at that point.
 */
function standingAt(after: WorldState, events: readonly WorldEvent[], index: number, residentId: string): Standing | undefined {
  const resident = Object.hasOwn(after.residents, residentId) ? after.residents[residentId] : undefined;
  if (!resident) return undefined;
  let at: Standing = { placeId: resident.placeId, homePlaceId: resident.homePlaceId, lifeStage: resident.lifeStage };
  for (let n = events.length - 1; n > index; n -= 1) {
    const event = events[n]!;
    if (event.type === "resident-location-changed" && event.residentId === residentId) at = { ...at, placeId: event.fromPlaceId };
    else if (event.type === "resident-moved-home" && event.residentId === residentId) at = { ...at, homePlaceId: event.before.homePlaceId };
    else if (event.type === "family-formed" && Object.hasOwn(event.residents, residentId)) {
      const before = event.residents[residentId]!.before;
      if (!before) return undefined;
      at = { placeId: before.placeId, homePlaceId: before.homePlaceId, lifeStage: before.lifeStage };
    }
  }
  return at;
}

/**
 * Replay check for one committed minute after the wardrobe opened.
 * - Provenance: every appearance change is the changing resident's own accepted model choice in that minute,
 *   with exactly that effect, fit for her life stage; every accepted wardrobe choice had its effect.
 * - Legality, by the kernel's own rules (`wardrobeChoices`) at the moment she chose: the wardrobe was already
 *   open, she was at her own home, her cooldown was over, and the choice changed what she wore.
 * - Prior appearances: a later zero-minute family formation never rewrites an existing resident's appearance.
 * Worlds whose wardrobe is not open, and everything before the opening, are not reinterpreted. Throws on mismatch.
 */
export function validateWardrobeMinute(after: WorldState, events: readonly WorldEvent[]): void {
  if (!after.life?.wardrobe) return;
  // When the opening is in this minute, only what follows it is wardrobe history.
  const opening = events.findIndex((event) => event.type === "wardrobe-opened");
  const changes = new Map<string, ResidentLifeChanged>();
  for (const event of events) {
    if (event.type !== "resident-life-changed" || same(event.before.appearance, event.after.appearance)) continue;
    if (changes.has(event.residentId)) throw new Error(`wardrobe change repeated for ${event.residentId}`);
    changes.set(event.residentId, event);
  }
  events.forEach((event, index) => {
    if (event.type !== "family-formed" || index < opening) return;
    for (const [residentId, change] of Object.entries(event.lifeProfiles)) {
      if (change.before && !same(change.before.appearance, change.after.appearance)) throw new Error(`wardrobe: family formation rewrote the appearance of ${residentId}`);
    }
  });
  const chosen = new Set<string>();
  events.forEach((event, index) => {
    if (event.type !== "resident-action-resolved" || event.outcome !== "accepted") return;
    const choice = parseWardrobeOptionId(event.optionId);
    if (!choice) return;
    const id = event.residentId;
    if (event.source !== "local-model") throw new Error(`wardrobe choice for ${id} was not the resident's own`);
    if (chosen.has(id)) throw new Error(`wardrobe choice repeated for ${id}`);
    chosen.add(id);
    const change = changes.get(id);
    const before = change?.before.appearance;
    const at = standingAt(after, events, index, id);
    if (!change || !before || !at) throw new Error(`wardrobe choice for ${id} has no own change`);
    if (!wardrobeChoiceAllowed(choice, at.lifeStage === "child")) throw new Error(`wardrobe choice not allowed for ${id}`);
    if (index < opening) throw new Error(`wardrobe choice for ${id} came before the wardrobe opened`);
    if (at.placeId !== at.homePlaceId) throw new Error(`wardrobe choice for ${id} was not made at home`);
    if (!wardrobeCooldownOver(before, event.minute)) throw new Error(`wardrobe choice for ${id} came within the cooldown`);
    if (!wardrobeChoiceChanges(before, choice)) throw new Error(`wardrobe choice for ${id} changed nothing she wore`);
    if (!same(applyWardrobeChoice(before, choice, event.minute), change.after.appearance)) throw new Error(`wardrobe effect mismatch for ${id}`);
  });
  for (const residentId of changes.keys()) if (!chosen.has(residentId)) throw new Error(`wardrobe change for ${residentId} has no own accepted choice`);
}
