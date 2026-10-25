import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";

export interface CelestialClockProps {
  canonicalMinute: number;
  reducedMotion?: boolean;
}

export function CelestialClock({ canonicalMinute, reducedMotion = false }: CelestialClockProps) {
  const clock = useRef<Group>(null);
  const targetRotation = ((canonicalMinute % 1440) / 1440) * Math.PI * 2;

  useFrame((_, delta) => {
    const target = clock.current;
    if (target === null) return;
    if (reducedMotion) {
      target.rotation.z = targetRotation;
      return;
    }
    target.rotation.z += (targetRotation - target.rotation.z) * Math.min(1, delta * 2.4);
  });

  return (
    <group ref={clock} position={[0, 7.4, -2.5]} rotation={[Math.PI / 2.7, 0, targetRotation]}>
      <mesh>
        <torusGeometry args={[3.1, 0.045, 6, 48]} />
        <meshBasicMaterial color="#f4cd73" toneMapped={false} />
      </mesh>
      <mesh rotation={[0.15, 0.5, 0.8]}>
        <torusGeometry args={[2.35, 0.035, 6, 40]} />
        <meshBasicMaterial color="#fff0af" toneMapped={false} />
      </mesh>
      <mesh rotation={[-0.3, 0.35, -0.5]}>
        <torusGeometry args={[1.6, 0.03, 6, 36]} />
        <meshBasicMaterial color="#f0b94f" toneMapped={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.28, 16, 12]} />
        <meshBasicMaterial color="#fff6ca" toneMapped={false} />
      </mesh>
    </group>
  );
}
