import { transitCellsAdjacent } from '../../world-schema/src/transit.js';
import { frontierParcelPosition,frontierResidentPosition,type FrontierParcelVisual } from './frontier-visuals.js';
type Foot=[number,number,number];
/** A viewer route over admitted charted parcels. Undefined legacy maps are handled by the caller. */
export function frontierGroundRoute(parcels:readonly FrontierParcelVisual[],from:Foot,to:Foot):Foot[]{
 const charted=parcels.filter(p=>p.state!=='fog').sort((a,b)=>a.ring-b.ring||a.slot-b.slot);
 const nearest=(foot:Foot)=>charted.reduce<FrontierParcelVisual|undefined>((best,p)=>{
   const [x,z]=frontierParcelPosition(p.ring,p.slot);const distance=Math.hypot(x-foot[0],z-foot[2]);
   if(distance>15)return best;
   if(!best)return p;const [bx,bz]=frontierParcelPosition(best.ring,best.slot);
   return distance<Math.hypot(bx-foot[0],bz-foot[2])?p:best;
 },undefined);
 const start=nearest(from),end=nearest(to);if(!start||!end)return [];
 const key=(p:FrontierParcelVisual)=>`${p.ring}:${p.slot}`;
 const parents=new Map<string,FrontierParcelVisual|null>([[key(start),null]]),queue=[start];
 for(let at=0;at<queue.length;at++){
   const here=queue[at]!;
   if(key(here)===key(end)){
     const cells=[here];for(let parent=parents.get(key(here));parent;parent=parents.get(key(parent)))cells.push(parent);
     return [from,...cells.reverse().map(p=>frontierResidentPosition(`landing-${p.ring}-${p.slot}`,'ground-route')!),to];
   }
   for(const next of charted)if(!parents.has(key(next))&&transitCellsAdjacent(here,next)){parents.set(key(next),here);queue.push(next);}
 }
 return [];
}
