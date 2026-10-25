import { randomInteger } from "./prng.js";
import { stableId, type GridCell, type TerrainGeometry } from "./generate-terrain.js";

export interface RoadSegment {
  id: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface RoadGeometry {
  cells: GridCell[];
  segments: RoadSegment[];
}

export interface Lot {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Building {
  id: string;
  lotId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DistrictGeometry {
  roads: RoadGeometry;
  lots: Lot[];
  buildings: Building[];
}

function coordinateKey(x: number, y: number): string {
  return `${x},${y}`;
}

function appendRoadLine(cells: Map<string, GridCell>, from: { x: number; y: number }, to: { x: number; y: number }, version: string, seed: string): void {
  const stepX = Math.sign(to.x - from.x);
  const stepY = Math.sign(to.y - from.y);
  let x = from.x;
  let y = from.y;
  while (true) {
    cells.set(coordinateKey(x, y), { id: stableId(version, seed, "road", x, y), x, y });
    if (x === to.x && y === to.y) return;
    x += stepX;
    y += stepY;
  }
}

function lotFits(x: number, y: number, water: Set<string>, roads: Set<string>, occupied: Set<string>): boolean {
  for (let lotY = y; lotY < y + 2; lotY += 1) {
    for (let lotX = x; lotX < x + 2; lotX += 1) {
      const key = coordinateKey(lotX, lotY);
      if (water.has(key) || roads.has(key) || occupied.has(key)) return false;
    }
  }
  return true;
}

export function generateDistrict(
  terrain: TerrainGeometry,
  input: { version: string; seed: string },
  random: () => number,
): DistrictGeometry {
  const water = new Set(terrain.water.cells.map((cell) => coordinateKey(cell.x, cell.y)));
  const roadCells = new Map<string, GridCell>();
  const waterDepth = terrain.water.cells.length / terrain.width;
  const trunkY = Math.min(terrain.height - 3, waterDepth + 3);
  const leftX = randomInteger(random, 2, Math.max(2, Math.floor(terrain.width / 3)));
  const rightX = randomInteger(random, Math.max(leftX + 4, Math.ceil((terrain.width * 2) / 3)), terrain.width - 3);
  const verticalStartY = waterDepth;
  const verticalEndY = terrain.height - 3;
  const horizontalFrom = { x: 1, y: trunkY };
  const horizontalTo = { x: terrain.width - 2, y: trunkY };
  const verticalLeftFrom = { x: leftX, y: verticalStartY };
  const verticalLeftTo = { x: leftX, y: verticalEndY };
  const verticalRightFrom = { x: rightX, y: verticalStartY };
  const verticalRightTo = { x: rightX, y: verticalEndY };

  appendRoadLine(roadCells, horizontalFrom, horizontalTo, input.version, input.seed);
  appendRoadLine(roadCells, verticalLeftFrom, verticalLeftTo, input.version, input.seed);
  appendRoadLine(roadCells, verticalRightFrom, verticalRightTo, input.version, input.seed);

  const roads = [...roadCells.values()];
  const roadCoordinates = new Set(roads.map((cell) => coordinateKey(cell.x, cell.y)));
  const occupied = new Set<string>();
  const lots: Lot[] = [];
  const buildings: Building[] = [];

  for (let y = waterDepth + 1; y < terrain.height - 2 && lots.length < 12; y += 3) {
    for (let x = 1; x < terrain.width - 2 && lots.length < 12; x += 3) {
      if (!lotFits(x, y, water, roadCoordinates, occupied)) continue;
      const lot: Lot = { id: stableId(input.version, input.seed, "lot", x, y), x, y, width: 2, height: 2 };
      lots.push(lot);
      for (let lotY = y; lotY < y + lot.height; lotY += 1) {
        for (let lotX = x; lotX < x + lot.width; lotX += 1) occupied.add(coordinateKey(lotX, lotY));
      }
      const buildingX = x + randomInteger(random, 0, lot.width - 1);
      const buildingY = y + randomInteger(random, 0, lot.height - 1);
      buildings.push({
        id: stableId(input.version, input.seed, "building", buildingX, buildingY),
        lotId: lot.id,
        x: buildingX,
        y: buildingY,
        width: 1,
        height: 1,
      });
    }
  }

  return {
    roads: {
      cells: roads,
      segments: [
        { id: stableId(input.version, input.seed, "road-segment-horizontal", trunkY, 0), from: horizontalFrom, to: horizontalTo },
        { id: stableId(input.version, input.seed, "road-segment-left", leftX, 0), from: verticalLeftFrom, to: verticalLeftTo },
        { id: stableId(input.version, input.seed, "road-segment-right", rightX, 0), from: verticalRightFrom, to: verticalRightTo },
      ],
    },
    lots,
    buildings,
  };
}
