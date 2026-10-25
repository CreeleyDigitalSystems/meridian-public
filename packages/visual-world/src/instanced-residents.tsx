import { useLayoutEffect, useRef } from "react";
import { InstancedMesh, Object3D } from "three";

import type { GeneratedWorldView } from "./founding-scene.js";
import { projectResidentPlacements, type ResidentVisualState } from "./projection-visuals.js";

export interface InstancedResidentsProps {
  world: GeneratedWorldView;
  residents: readonly ResidentVisualState[];
  selectedResidentId: string | null;
  onSelectResident?: ((residentId: string) => void) | undefined;
}

export function InstancedResidents({
  world,
  residents,
  selectedResidentId,
  onSelectResident,
}: InstancedResidentsProps) {
  const mesh = useRef<InstancedMesh>(null);

  useLayoutEffect(() => {
    const target = mesh.current;
    if (target === null) return;

    const transform = new Object3D();
    for (const [index, resident] of projectResidentPlacements(world, residents).entries()) {
      const selectedScale = resident.id === selectedResidentId ? 1.45 : 1;
      transform.position.set(resident.x, 0.6, resident.z);
      transform.scale.setScalar(selectedScale);
      transform.updateMatrix();
      target.setMatrixAt(index, transform.matrix);
    }
    target.instanceMatrix.needsUpdate = true;
    target.computeBoundingSphere();
  }, [residents, selectedResidentId, world]);

  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, residents.length]}
      onClick={(event) => {
        event.stopPropagation();
        const resident = event.instanceId === undefined ? undefined : residents[event.instanceId];
        if (resident !== undefined) onSelectResident?.(resident.id);
      }}
    >
      <capsuleGeometry args={[0.12, 0.36, 4, 8]} />
      <meshStandardMaterial color="#fff8e8" emissive="#f5c96a" emissiveIntensity={0.45} roughness={0.32} />
    </instancedMesh>
  );
}
