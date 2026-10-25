import type { ConstructionStage } from './projection-visuals.js';
/** A status indicator at the existing construction-site anchor, not a finished building. */
export function constructionIndicator(stage: ConstructionStage): {
  height: number;
  color: string;
} | null {
  if (stage === 'unavailable') return null;
  const height = {
    foundation: .3,
    frame: 1.2,
    enclosure: 1.8,
    fitout: 2.4,
    complete: 3
  }[stage];
  return {
    height,
    color: stage === 'complete' ? '#cae9da' : '#d8a84e'
  };
}
export function PublicConstructionIndicator({
  stage
}: {
  stage: ConstructionStage;
}) {
  const indicator = constructionIndicator(stage);
  if (!indicator) return null;
  return <group name={`construction-status-${stage}`} position={[14, .56, -10]}>
  <mesh position={[0, .1, 0]}>
    <boxGeometry args={[.8, .2, .8]} />
    <meshStandardMaterial color="#d4cec0" />
  </mesh>
  <mesh position={[0, indicator.height / 2 + .2, 0]}>
    <boxGeometry args={[.16, indicator.height, .16]} />
    <meshStandardMaterial color={indicator.color} />
  </mesh>
  <mesh position={[.24, indicator.height + .2, 0]}>
    <boxGeometry args={[.5, .3, .04]} />
    <meshStandardMaterial color={indicator.color} />
  </mesh>
</group>;
}
