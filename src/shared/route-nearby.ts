import type {Coordinate,Geometry,SpatialAsset} from './maps.js';

/** Short local distances only; a road geometry is required, never a stop-to-stop straight line. */
export function distanceToRoute(point:Coordinate, geometries:Geometry[]):number {
 const scale=Math.cos(point[1]*Math.PI/180),project=(p:Coordinate)=>[(p[0]-point[0])*111195*scale,(p[1]-point[1])*111195];
 let minimum=Infinity;
 for(const geometry of geometries) {
  const lines=geometry.type==='LineString'?[geometry.coordinates]:geometry.type==='MultiLineString'?geometry.coordinates:[];
  for(const line of lines)for(let i=1;i<line.length;i++) {
   const a=project(line[i-1]),b=project(line[i]),dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
   const t=length?Math.max(0,Math.min(1,-(a[0]*dx+a[1]*dy)/length)):0;
   minimum=Math.min(minimum,Math.hypot(a[0]+t*dx,a[1]+t*dy));
  }
 }
 return minimum;
}
export function routeNearby(assets:SpatialAsset[],routes:SpatialAsset[],planned:SpatialAsset[],radius=300):SpatialAsset[] {
 const geometry=routes.filter(route=>route.route?.mode==='walk').map(route=>route.geometry);
 const seen=new Set(planned.map(place=>place.entityId));
 return assets.filter(asset=>{
  if(asset.geometry.type!=='Point'||seen.has(asset.entityId)||distanceToRoute(asset.geometry.coordinates,geometry)>radius)return false;
  seen.add(asset.entityId);return true;
 }).sort((a,b)=>distanceToRoute((a.geometry as {coordinates:Coordinate}).coordinates,geometry)-distanceToRoute((b.geometry as {coordinates:Coordinate}).coordinates,geometry));
}

/** Sample each real road leg every kilometre, including its endpoints; never bridge separate legs. */
export function routeSearchCenters(route:SpatialAsset):Coordinate[] {
 if(route.route?.mode!=='walk')return [];
 const g=route.geometry,lines=g.type==='LineString'?[g.coordinates]:g.type==='MultiLineString'?g.coordinates:[];
 const points:Coordinate[]=[];
 const add=(p:Coordinate)=>{if(points.length>=2000)throw new Error('路线过长，请分段查询沿途地点');points.push(p);};
 for(const line of lines) {
  if(!line.length)continue;
  add(line[0]);let remaining=1000;
  for(let i=1;i<line.length;i++) {
   let a=line[i-1];const b=line[i];
   let length=Math.hypot((b[0]-a[0])*111195*Math.cos((a[1]+b[1])*Math.PI/360),(b[1]-a[1])*111195);
   while(length>=remaining) {
    const fraction=remaining/length;
    a=[a[0]+(b[0]-a[0])*fraction,a[1]+(b[1]-a[1])*fraction];add(a);
    length-=remaining;remaining=1000;
   }
   remaining-=length;
  }
  const end=line.at(-1)!;
  if(points.at(-1)![0]!==end[0]||points.at(-1)![1]!==end[1])add(end);
 }
 return points.filter((point,index)=>points.findIndex(other=>other[0]===point[0]&&other[1]===point[1])===index);
}
