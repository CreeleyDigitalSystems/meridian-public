import { BufferGeometry, Float32BufferAttribute, SphereGeometry } from "three";
import type { ResidentDetailBudget } from "./quality-policy.js";

export interface ResidentDetailSlots { near: string[]; mid: string[]; base: string[] }
/** Stable, explicit slot -> resident maps; selection changes detail, never world state. */
export function selectResidentDetailSlots(
  residents: readonly {id: string}[], positions: ReadonlyMap<string, readonly [number, number, number]>,
  camera: {x:number;y:number;z:number}, selectedId: string | null | undefined, budget: ResidentDetailBudget,
): ResidentDetailSlots {
  const distance = (id: string) => {
    const p = positions.get(id);
    return p ? (p[0]-camera.x)**2 + (p[1]-camera.y)**2 + (p[2]-camera.z)**2 : Infinity;
  };
  const ranked = residents.map(r => r.id).sort((a,b) => {
    if (a === selectedId) return -1;
    if (b === selectedId) return 1;
    const d = distance(a)-distance(b);
    return (Number.isNaN(d) ? 0 : d) || (a < b ? -1 : a > b ? 1 : 0);
  });
  const near = Math.max(0, Math.floor(budget.near)), mid = Math.max(0, Math.floor(budget.mid));
  return {near:ranked.slice(0,near),mid:ranked.slice(near,near+mid),base:ranked.slice(near+mid)};
}

/** This is the exact tessellation used by every base head, including its flat facets. */
export const RESIDENT_HEAD_GEOMETRY = [.17, 8, 5] as const;
type Point = [number, number, number];
const headFacets = (() => {
  const geometry = new SphereGeometry(...RESIDENT_HEAD_GEOMETRY);
  const p = geometry.attributes.position!, indices = geometry.index!.array;
  const facets: Point[][] = [];
  for (let i=0;i<indices.length;i+=3) {
    const points = [indices[i]!,indices[i+1]!,indices[i+2]!].map(index => [p.getX(index),p.getY(index),p.getZ(index)] as Point);
    const [a,b,c]=points as [Point,Point,Point];
    if ((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]) > 1e-12) facets.push(points);
  }
  geometry.dispose();
  return facets;
})();

/** Place a tiny face patch on its real facet, aligned with that facet's normal. */
export function residentFaceAttachment(faceScale: Point, x: number, y: number): {position: Point; rotation: Point} {
  const u=x/faceScale[0], v=y/faceScale[1];
  for (const points of headFacets) {
    const [a,b,c]=points as [Point,Point,Point];
    const bx=b[0]-a[0], by=b[1]-a[1], bz=b[2]-a[2];
    const cx=c[0]-a[0], cy=c[1]-a[1], cz=c[2]-a[2];
    const determinant=bx*cy-by*cx;
    const s=((u-a[0])*cy-(v-a[1])*cx)/determinant;
    const t=(bx*(v-a[1])-by*(u-a[0]))/determinant;
    if(s < -1e-7 || t < -1e-7 || s+t > 1+1e-7) continue;
    const nx=(by*cz-bz*cy)/faceScale[0], ny=(bz*cx-bx*cz)/faceScale[1], nz=determinant/faceScale[2];
    const length=Math.hypot(nx,ny,nz), normal:Point=[nx/length,ny/length,nz/length];
    // A 0.00025 rig-unit offset avoids z-fighting without visible separation.
    const offset=.00025;
    return {position:[x+normal[0]*offset,y+normal[1]*offset,(a[2]+s*bz+t*cz)*faceScale[2]+normal[2]*offset],rotation:[-Math.asin(normal[1]),Math.atan2(normal[0],normal[2]),0]};
  }
  throw new RangeError("face detail is outside the resident head surface");
}

/** Thin, tapered fabric with three drape levels; 20 triangles shared by every panel. */
export function createResidentGarmentGeometry(): BufferGeometry {
  const positions:number[]=[];
  for(const [y,width,z] of [[.5,.60,-.4],[0,1,.45],[-.5,.85,-.32]]) {
    for(const depth of [z!,z!-.12]) for(const side of [-1,1]) positions.push(side*width!/2,y!,depth);
  }
  const indices:number[]=[];
  const quad=(a:number,b:number,c:number,d:number)=>indices.push(a,b,d,b,c,d);
  for(let row=0;row<2;row++) {
    const a=row*4,b=a+4;
    quad(a,b,b+1,a+1); // front
    quad(a+2,a+3,b+3,b+2); // back
    quad(a,a+2,b+2,b); // left
    quad(a+1,b+1,b+3,a+3); // right
  }
  quad(0,1,3,2);quad(8,10,11,9);
  const geometry=new BufferGeometry();
  geometry.setAttribute("position",new Float32BufferAttribute(positions,3));
  geometry.setIndex(indices);geometry.computeVertexNormals();
  return geometry;
}
