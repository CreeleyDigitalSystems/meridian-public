import { useMemo } from 'react';
import { createPlanLayout, type PlanRect } from './city-plan.js';
import { CITY_GROUND_Y } from './city-walkability.js';
import type { CityLight } from './city-layout.js';

/** Actual procedural shells, roofs and doors replace the unresolved binary city kit. */
export function CityKit({ hiddenPlaceId, light }: { light?: CityLight; efficient?: boolean; hiddenPlaceId?: string | undefined; hiddenRect?: PlanRect | undefined }) {
  const buildings = useMemo(createPlanLayout, []);
  return <group name="public-procedural-buildings">{buildings.filter(b => b.placeId !== hiddenPlaceId).map(b => <group key={b.placeId!} position={[b.x, CITY_GROUND_Y, b.z]}>
    <mesh position={[0, b.height / 2, 0]} castShadow receiveShadow><boxGeometry args={[4, b.height, 4]} /><meshStandardMaterial color={b.placeId?.startsWith('home') ? '#e7dfcc' : '#b7c8d0'} roughness={.8} /></mesh>
    <mesh position={[0, b.height + .15, 0]} castShadow><boxGeometry args={[4.4, .3, 4.4]} /><meshStandardMaterial color="#9b654e" roughness={.85} /></mesh>
    <mesh position={[0, .9, 2.02]}><boxGeometry args={[.8, 1.8, .06]} /><meshStandardMaterial color="#554637" emissive={light === 'blue-hour' ? '#403018' : '#000000'} /></mesh>
  </group>)}</group>;
}
