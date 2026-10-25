import { useLayoutEffect, useMemo, useRef } from "react";
import { Color, InstancedMesh, Object3D } from "three";

import type { GeneratedWorldView } from "./founding-scene.js";
import { constructionStageProfile, type ConstructionStage } from "./projection-visuals.js";

export function InstancedBuildings({ world, constructionStage }: { world: GeneratedWorldView; constructionStage: ConstructionStage }) {
  const mesh = useRef<InstancedMesh>(null);
  const pearl = useMemo(() => new Color("#f5f1df"), []);

  useLayoutEffect(() => {
    const target = mesh.current;
    if (target === null) return;

    const transform = new Object3D();
    const stage = constructionStageProfile(constructionStage);
    const constructionColor = new Color(stage.color);
    for (const [index, building] of world.buildings.entries()) {
      const terrain = world.heightCells[building.y * world.width + building.x];
      const fullHeight = 1.8 + ((terrain?.height ?? 32) / 96) * 4.8;
      const towerHeight = index === world.buildings.length - 1 ? fullHeight * stage.heightScale : fullHeight;
      transform.position.set(
        building.x - world.width / 2 + 0.5,
        towerHeight / 2 + 0.18,
        building.y - world.height / 2 + 0.5,
      );
      transform.scale.set(building.width * 0.76, towerHeight, building.height * 0.76);
      transform.updateMatrix();
      target.setMatrixAt(index, transform.matrix);
      target.setColorAt(index, index === world.buildings.length - 1 ? constructionColor : pearl);
    }
    target.instanceMatrix.needsUpdate = true;
    if (target.instanceColor !== null) target.instanceColor.needsUpdate = true;
    target.computeBoundingSphere();
  }, [constructionStage, pearl, world]);

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, world.buildings.length]} castShadow receiveShadow>
      <cylinderGeometry args={[0.44, 0.54, 1, 10]} />
      <meshStandardMaterial color={pearl} emissive="#2dd4c7" emissiveIntensity={0.08} metalness={0.3} roughness={0.28} />
    </instancedMesh>
  );
}
