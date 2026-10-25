import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BackSide, Color, PlaneGeometry, ShaderMaterial, Vector3 } from "three";

/** The visible sun; the key light and the sky's glow both come from this direction. */
export const SUN_POSITION = new Vector3(-95, 55, -170);
import type { CityLight } from "./city-layout.js";
import { ATMOSPHERE } from "./city-theme.js";

export function CityAtmosphere({ light, reducedMotion }: { light: CityLight; reducedMotion: boolean }) {
  const sky = useMemo(() => new ShaderMaterial({
    side: BackSide, depthWrite: false,
    uniforms: { top: { value: new Color(ATMOSPHERE.day.zenith) }, bottom: { value: new Color(ATMOSPHERE.day.horizon) }, cloudOpacity: { value: ATMOSPHERE.day.cloudOpacity }, sunDir: { value: SUN_POSITION.clone().normalize() }, sunGlow: { value: 0.0 } },
    vertexShader: "varying vec3 vPosition; void main(){ vPosition=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
    fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform float cloudOpacity; uniform vec3 sunDir; uniform float sunGlow; varying vec3 vPosition;
      void main(){
        vec3 d=normalize(vPosition); float h=smoothstep(-0.08,0.72,d.y); vec3 col=mix(bottom,top,h);
        float bands=sin(d.x*13.0+d.z*8.0)+sin(d.x*31.0-d.z*17.0)*0.38+sin(d.x*67.0+d.z*43.0)*0.12;
        float cloud=smoothstep(0.55,1.18,bands)*(1.0-smoothstep(0.12,0.72,abs(d.y-0.22)));
        col=mix(col,vec3(0.98,0.96,0.91),cloud*cloudOpacity);
        float horizon=1.0-smoothstep(0.0,0.22,abs(d.y)); col=mix(col,bottom,horizon*0.22);
        float s=max(dot(d,sunDir),0.0); col+=vec3(1.0,0.93,0.78)*(pow(s,6.0)*0.32+pow(s,48.0)*0.4)*sunGlow;
        gl_FragColor=vec4(col,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }), []);
  const water = useMemo(() => new ShaderMaterial({
    uniforms: { time: { value: 0 }, deep: { value: new Color("#1f5a5e") }, shallow: { value: new Color("#8fc3bb") }, sun: { value: new Color("#f3d8a8") } },
    vertexShader: "varying vec3 vWorld; void main(){ vec4 wp=modelMatrix*vec4(position,1.0); vWorld=wp.xyz; gl_Position=projectionMatrix*viewMatrix*wp; }",
    fragmentShader: `uniform float time; uniform vec3 deep; uniform vec3 shallow; uniform vec3 sun; varying vec3 vWorld;
      void main(){ vec2 p=vWorld.xz; float w=sin(p.x*1.5+sin(p.y*.52)+time*.55)*sin(p.y*1.7-time*.4); float fine=sin(p.x*4.2+p.y*2.4+time)*.5+.5;
      float fres=pow(clamp(length(p)/180.,0.,1.),.45); vec3 col=mix(deep,shallow,fres*.7+w*.075);
      float glint=pow(max(0.,w),13.)*fine; col+=sun*glint*.1; float shore=1.-smoothstep(43.,47.,length(p)); col=mix(col,shallow*.7,shore*.38); col=mix(col,shallow,smoothstep(100.,420.,length(p)));
      gl_FragColor=vec4(col,1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`,
  }), []);
  const timer = useRef(0);
  useFrame((_, dt) => {
    if (!reducedMotion) timer.current += Math.min(dt, 0.05);
    water.uniforms.time!.value = timer.current;
  });
  const night = light === "blue-hour";
  // Warm daylight haze over a blue zenith; blue hour keeps its cool sky and the lit windows do the colour work.
  const profile = night ? ATMOSPHERE.night : ATMOSPHERE.day;
  sky.uniforms.top!.value.set(profile.zenith);
  sky.uniforms.bottom!.value.set(profile.horizon);
  sky.uniforms.cloudOpacity!.value = profile.cloudOpacity;
  sky.uniforms.sunGlow!.value = night ? 0 : 1;
  water.uniforms.deep!.value.set(night ? "#102e48" : "#6e918a");
  water.uniforms.shallow!.value.set(night ? "#447689" : "#d3dfd3");
  return <>
    {/* Day and blue hour both draw their sky: the warm daylight dome glows toward the sun. */}
    <mesh material={sky}><sphereGeometry args={[900, 24, 16]} /></mesh>
    <mesh position={[0, -0.4, 0]} rotation={[-Math.PI / 2, 0, 0]} material={water}><planeGeometry args={[1700, 1700]} /></mesh>
    <DistantTerrain />
    <mesh position={SUN_POSITION.toArray()}><sphereGeometry args={[night ? 7 : 12, 24, 16]} /><meshBasicMaterial color={night ? "#ede9da" : "#fff0cf"} fog={false} toneMapped={false} /></mesh>
  </>;
}

function DistantTerrain() {
  const terrain = useMemo(() => {
    const g = new PlaneGeometry(360, 130, 100, 50);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position!;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const edge = Math.max(0, 1 - (z / 65) ** 2) * Math.max(0, 1 - (x / 180) ** 8);
      const ridge = 12 + 10 * Math.sin(x * .031) + 6 * Math.sin(x * .085 + z * .025) + 3 * Math.sin(x * .23 + z * .15);
      p.setY(i, Math.max(-3, ridge * edge - 3));
    }
    g.computeVertexNormals();
    return g;
  }, []);
  return <group position={[0, -1, -165]}><mesh geometry={terrain}><meshStandardMaterial color="#b3ab92" roughness={1} /></mesh></group>;
}
