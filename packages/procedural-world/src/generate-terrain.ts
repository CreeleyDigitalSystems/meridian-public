import { mulberry32, randomInteger, seedToUint32 } from "./prng.js";

export const FOUNDING_TERRAIN_VERSION = "founding-terrain-1" as const;
export const MIN_GRID_SIZE = 16;
export const MAX_GRID_SIZE = 64;
export const DEFAULT_GRID_SIZE = 32;

export interface GridCell {
  id: string;
  x: number;
  y: number;
}

export interface HeightCell extends GridCell {
  height: number;
}

export interface GeneratorInput {
  version: string;
  seed: string;
  width?: number;
  height?: number;
}

export interface WaterGeometry {
  boundary: "north";
  cells: GridCell[];
}

export interface TerrainGeometry {
  width: number;
  height: number;
  heightCells: HeightCell[];
  water: WaterGeometry;
}

export function stableId(version: string, seed: string, kind: string, x: number, y: number): string {
  return `${version}:${seed}:${kind}:${x}:${y}`;
}

export function normaliseInput(input: GeneratorInput): Required<GeneratorInput> {
  if (input.version !== FOUNDING_TERRAIN_VERSION) {
    throw new RangeError(`unsupported generator version: ${input.version}`);
  }
  if (typeof input.seed !== "string" || input.seed.length === 0) {
    throw new RangeError("seed must be a non-empty string");
  }

  const width = input.width ?? DEFAULT_GRID_SIZE;
  const height = input.height ?? DEFAULT_GRID_SIZE;
  for (const [name, value] of [["width", width], ["height", height]] as const) {
    if (!Number.isInteger(value) || value < MIN_GRID_SIZE || value > MAX_GRID_SIZE) {
      throw new RangeError(`${name} must be an integer between ${MIN_GRID_SIZE} and ${MAX_GRID_SIZE}`);
    }
  }
  return { version: input.version, seed: input.seed, width, height };
}

export function generateTerrain(input: Required<GeneratorInput>): TerrainGeometry {
  const random = mulberry32(seedToUint32(input.seed));
  const waterDepth = randomInteger(random, 2, 3);
  const heightCells: HeightCell[] = [];
  const waterCells: GridCell[] = [];

  for (let y = 0; y < input.height; y += 1) {
    for (let x = 0; x < input.width; x += 1) {
      const height = y < waterDepth ? 0 : randomInteger(random, 18, 96);
      heightCells.push({
        id: stableId(input.version, input.seed, "height", x, y),
        x,
        y,
        height,
      });
      if (y < waterDepth) {
        waterCells.push({ id: stableId(input.version, input.seed, "water", x, y), x, y });
      }
    }
  }

  return {
    width: input.width,
    height: input.height,
    heightCells,
    water: { boundary: "north", cells: waterCells },
  };
}
