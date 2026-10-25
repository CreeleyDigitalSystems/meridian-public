import { generateDistrict, type Building, type DistrictGeometry, type Lot, type RoadGeometry } from "./generate-district.js";
import {
  FOUNDING_TERRAIN_VERSION,
  generateTerrain,
  normaliseInput,
  type GeneratorInput,
  type GridCell,
  type HeightCell,
  type WaterGeometry,
} from "./generate-terrain.js";
import { mulberry32, seedToUint32 } from "./prng.js";

export { FOUNDING_TERRAIN_VERSION };
export type { GeneratorInput, GridCell, HeightCell, WaterGeometry, Lot, Building, RoadGeometry };

export interface GeneratedWorld extends DistrictGeometry {
  version: typeof FOUNDING_TERRAIN_VERSION;
  seed: string;
  width: number;
  height: number;
  heightCells: HeightCell[];
  water: WaterGeometry;
}

export function generateWorld(input: GeneratorInput): GeneratedWorld {
  const normalised = normaliseInput(input);
  const terrain = generateTerrain(normalised);
  const random = mulberry32(seedToUint32(`${normalised.seed}:district`));
  const district = generateDistrict(terrain, normalised, random);
  return { version: FOUNDING_TERRAIN_VERSION, seed: normalised.seed, ...terrain, ...district };
}

function pointKey(x: number, y: number): string {
  return `${x},${y}`;
}

function isInteger(value: number): boolean {
  return Number.isInteger(value);
}

function isInBounds(x: number, y: number, world: GeneratedWorld): boolean {
  return isInteger(x) && isInteger(y) && x >= 0 && y >= 0 && x < world.width && y < world.height;
}

function rectangleIsInside(
  x: number,
  y: number,
  width: number,
  height: number,
  container: { x: number; y: number; width: number; height: number },
): boolean {
  return x >= container.x && y >= container.y && x + width <= container.x + container.width && y + height <= container.y + container.height;
}

function rectanglesOverlap(a: Lot, b: Lot): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Returns ordered, human-readable invariants; it never mutates the supplied world. */
export function validateGeneratedWorld(world: GeneratedWorld): string[] {
  const violations: string[] = [];
  if (world.version !== FOUNDING_TERRAIN_VERSION) violations.push(`unsupported generator version: ${world.version}`);
  if (!Number.isInteger(world.width) || world.width < 16 || world.width > 64) violations.push("width must be an integer between 16 and 64");
  if (!Number.isInteger(world.height) || world.height < 16 || world.height > 64) violations.push("height must be an integer between 16 and 64");
  if (world.water.boundary !== "north") violations.push("water boundary must be north");

  const allIds = [
    ...world.heightCells.map((cell) => cell.id),
    ...world.water.cells.map((cell) => cell.id),
    ...world.roads.cells.map((cell) => cell.id),
    ...world.roads.segments.map((segment) => segment.id),
    ...world.lots.map((lot) => lot.id),
    ...world.buildings.map((building) => building.id),
  ];
  if (new Set(allIds).size !== allIds.length) violations.push("all geometry identifiers must be unique");

  if (world.heightCells.length !== world.width * world.height) violations.push("height cells must cover the complete grid");
  const heightCoordinates = new Set<string>();
  for (const cell of world.heightCells) {
    const key = pointKey(cell.x, cell.y);
    if (!isInBounds(cell.x, cell.y, world) || !isInteger(cell.height)) violations.push(`height cell ${cell.id} is not integer grid geometry`);
    if (heightCoordinates.has(key)) violations.push(`duplicate height cell at ${key}`);
    heightCoordinates.add(key);
  }

  const waterCoordinates = new Set<string>();
  for (const cell of world.water.cells) {
    const key = pointKey(cell.x, cell.y);
    if (!isInBounds(cell.x, cell.y, world)) violations.push(`water cell ${cell.id} is outside the grid`);
    if (waterCoordinates.has(key)) violations.push(`duplicate water cell at ${key}`);
    waterCoordinates.add(key);
  }
  if (![...waterCoordinates].some((key) => key.endsWith(",0"))) violations.push("water must touch its north boundary");

  const roadCoordinates = new Set<string>();
  for (const cell of world.roads.cells) {
    const key = pointKey(cell.x, cell.y);
    if (!isInBounds(cell.x, cell.y, world)) violations.push(`road cell ${cell.id} is outside the grid`);
    if (waterCoordinates.has(key)) violations.push(`road cell ${cell.id} is on water`);
    if (roadCoordinates.has(key)) violations.push(`duplicate road cell at ${key}`);
    roadCoordinates.add(key);
  }
  for (const segment of world.roads.segments) {
    if (!isInBounds(segment.from.x, segment.from.y, world) || !isInBounds(segment.to.x, segment.to.y, world)) {
      violations.push(`road segment ${segment.id} is outside the grid`);
    }
    if (!roadCoordinates.has(pointKey(segment.from.x, segment.from.y)) || !roadCoordinates.has(pointKey(segment.to.x, segment.to.y))) {
      violations.push(`road segment ${segment.id} endpoints are not road cells`);
    }
  }
  if (roadCoordinates.size === 0) {
    violations.push("road network must contain road cells");
  } else {
    const [firstRoad] = roadCoordinates;
    if (firstRoad !== undefined) {
      const reached = new Set([firstRoad]);
      const queue = [firstRoad];
      for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index];
        if (current === undefined) continue;
        const [xText, yText] = current.split(",");
        if (xText === undefined || yText === undefined) continue;
        const x = Number(xText);
        const y = Number(yText);
        for (const neighbour of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          const key = pointKey(neighbour[0] ?? 0, neighbour[1] ?? 0);
          if (roadCoordinates.has(key) && !reached.has(key)) {
            reached.add(key);
            queue.push(key);
          }
        }
      }
      if (reached.size !== roadCoordinates.size) violations.push("road cells must form one connected network");
    }
  }

  for (const lot of world.lots) {
    if (!isInBounds(lot.x, lot.y, world) || !isInteger(lot.width) || !isInteger(lot.height) || lot.width <= 0 || lot.height <= 0 || lot.x + lot.width > world.width || lot.y + lot.height > world.height) {
      violations.push(`lot ${lot.id} is not an in-bounds integer rectangle`);
      continue;
    }
    for (let y = lot.y; y < lot.y + lot.height; y += 1) {
      for (let x = lot.x; x < lot.x + lot.width; x += 1) {
        const key = pointKey(x, y);
        if (waterCoordinates.has(key)) violations.push(`lot ${lot.id} is on water`);
        if (roadCoordinates.has(key)) violations.push(`lot ${lot.id} overlaps a road`);
      }
    }
  }
  for (let index = 0; index < world.lots.length; index += 1) {
    const lot = world.lots[index];
    if (lot === undefined) continue;
    for (const other of world.lots.slice(index + 1)) {
      if (rectanglesOverlap(lot, other)) violations.push(`lots ${lot.id} and ${other.id} overlap`);
    }
  }

  const buildingsByLot = new Map<string, number>();
  const lotsById = new Map(world.lots.map((lot) => [lot.id, lot]));
  for (const building of world.buildings) {
    const lot = lotsById.get(building.lotId);
    if (!isInBounds(building.x, building.y, world) || !isInteger(building.width) || !isInteger(building.height) || building.width <= 0 || building.height <= 0 || building.x + building.width > world.width || building.y + building.height > world.height) {
      violations.push(`building ${building.id} is not an in-bounds integer rectangle`);
    }
    if (lot === undefined || !rectangleIsInside(building.x, building.y, building.width, building.height, lot)) {
      violations.push(`building ${building.id} is not inside lot ${building.lotId}`);
    }
    buildingsByLot.set(building.lotId, (buildingsByLot.get(building.lotId) ?? 0) + 1);
  }
  for (const lot of world.lots) {
    if (buildingsByLot.get(lot.id) !== 1) violations.push(`lot ${lot.id} must contain exactly one building`);
  }
  return violations;
}
