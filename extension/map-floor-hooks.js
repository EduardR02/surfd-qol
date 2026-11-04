// Narrow the native floor filter with the loaded broadphase. Its original
// strict Z tests and default-flag trace still decide the floor height.
export function zoneFloorCandidates(world, map, x, y, bottom, top) {
  if (!world || world.brushes !== map.brushes ||
      world.triangles !== map.displacementTriangles &&
      !(map.displacementTriangles === undefined && world.triangles.length === 0)) return null;
  const brushes = [], triangles = map.displacementTriangles ? [] : undefined;
  for (const index of world.tree.query({min: {x, y, z: bottom}, max: {x, y, z: top}})) {
    if (index < map.brushes.length) brushes.push(map.brushes[index]);
    else triangles?.push(map.displacementTriangles[index - map.brushes.length]);
  }
  return {brushes, triangles};
}

export function nativeMapFloorHooks(source, contract) {
  if (contract?.name !== 'k1') return source;
  const floor = 'function Vb(n,e){const t=e.kind==="start"?n.spawn.position:ju[n.id],i=t?.x??(e.min.x+e.max.x)/2,s=t?.y??(e.min.y+e.max.y)/2,r=Math.min(e.max.z-1,t?t.z+1:e.max.z-1),a=e.min.z-128,o=n.brushes.filter(d=>d.min.x<=i&&d.max.x>=i&&d.min.y<=s&&d.max.y>=s&&d.min.z<r&&d.max.z>a),c=n.displacementTriangles?.filter(d=>Math.min(...d.vertices.map(u=>u.x))<=i&&Math.max(...d.vertices.map(u=>u.x))>=i&&Math.min(...d.vertices.map(u=>u.y))<=s&&Math.max(...d.vertices.map(u=>u.y))>=s&&Math.min(...d.vertices.map(u=>u.z))<r&&Math.max(...d.vertices.map(u=>u.z))>a),l=new k1(o,c).trace({x:i,y:s,z:r},{x:i,y:s,z:a},{min:{x:0,y:0,z:0},max:{x:0,y:0,z:0}});return l.brush&&!l.startSolid&&l.normal.z>.5?e.kind==="start"?l.end.z:Math.max(e.min.z,l.end.z):e.min.z}';
  if (!source.includes(floor) || source.indexOf(floor) !== source.lastIndexOf(floor)) return source;
  const tree = contract.signature.match(/class ([\w$]+)\{constructor\([\w$]+,[\w$]+=12\)/)?.[1];
  const brushes = contract.signature.match(/class k1\{constructor\(([\w$]+),/)?.[1];
  if (!tree || !brushes) return source;
  const ending = `this.tree=new ${tree}([...${brushes},...this.triangleBounds])}`;
  if (!source.includes(ending) || source.indexOf(ending) !== source.lastIndexOf(ending)) return source;
  const replacement = floor.replace('a=e.min.z-128,o=n.brushes.filter',
    'a=e.min.z-128,__qolFloor=__qolZoneFloorCandidates(__qolFloorWorlds.get(n.brushes),n,i,s,a,r),o=(__qolFloor?.brushes??n.brushes).filter')
    .replace('c=n.displacementTriangles?.filter', 'c=(__qolFloor?__qolFloor.triangles:n.displacementTriangles)?.filter');
  return source.replace(floor, replacement).replace(ending,
    `this.tree=new ${tree}([...${brushes},...this.triangleBounds]);__qolFloorWorlds.set(${brushes},this)}`);
}
