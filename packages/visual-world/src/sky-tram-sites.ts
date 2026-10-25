/**
 * Where the sky tram meets the city (no imports, so walkability and routing can both read it without a cycle).
 * Eight quay stations stand on the waterside paving at the compass bearings: inside the island's edge (41.5), outside
 * the build limit (37.9) and between the quay cypresses (planted every ~5° either side of each bearing).
 */
export const TRAM_Y = 9;
/** A rider's feet aboard a car: on the cabin floor, just above the rail. */
export const RIDE_Y = TRAM_Y + .3;
export const QUAY_STATION_RADIUS = 40.5;
/** People keep this far from a quay station's tower; they board from the city side of it. */
export const QUAY_STATION_CLEARANCE = 1.05;
export const TRAM_BEARINGS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * Math.PI / 4);
export const QUAY_STATIONS: readonly (readonly [number, number])[] = TRAM_BEARINGS.map((b) => [Math.sin(b) * QUAY_STATION_RADIUS, -Math.cos(b) * QUAY_STATION_RADIUS]);
