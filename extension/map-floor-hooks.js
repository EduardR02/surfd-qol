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

// The reviewed native floor functions, with @F (function), @T (marker table)
// and @W (world class) standing for their bundle's names. Each lists the edits
// that route its brush and displacement filters through the candidates.
const floors = [
  {text: 'function @F(n,e){const t=e.kind==="start"?n.spawn.position:@T[n.id],i=t?.x??(e.min.x+e.max.x)/2,s=t?.y??(e.min.y+e.max.y)/2,r=Math.min(e.max.z-1,t?t.z+1:e.max.z-1),a=e.min.z-128,o=n.brushes.filter(d=>d.min.x<=i&&d.max.x>=i&&d.min.y<=s&&d.max.y>=s&&d.min.z<r&&d.max.z>a),c=n.displacementTriangles?.filter(d=>Math.min(...d.vertices.map(u=>u.x))<=i&&Math.max(...d.vertices.map(u=>u.x))>=i&&Math.min(...d.vertices.map(u=>u.y))<=s&&Math.max(...d.vertices.map(u=>u.y))>=s&&Math.min(...d.vertices.map(u=>u.z))<r&&Math.max(...d.vertices.map(u=>u.z))>a),l=new @W(o,c).trace({x:i,y:s,z:r},{x:i,y:s,z:a},{min:{x:0,y:0,z:0},max:{x:0,y:0,z:0}});return l.brush&&!l.startSolid&&l.normal.z>.5?e.kind==="start"?l.end.z:Math.max(e.min.z,l.end.z):e.min.z}',
    edits: [['a=e.min.z-128,o=n.brushes.filter', 'a=e.min.z-128,__qolFloor=__qolZoneFloorCandidates(__qolFloorWorlds.get(n.brushes),n,i,s,a,r),o=(__qolFloor?.brushes??n.brushes).filter']]},
  // The bonus update made the start point a parameter, so bonus zones on the main map pass their own spawn.
  {text: 'function @F(n,e,t=e.kind==="start"?n.spawn.position:@T[n.id]){const i=t?.x??(e.min.x+e.max.x)/2,a=t?.y??(e.min.y+e.max.y)/2,s=Math.min(e.max.z-1,t?t.z+1:e.max.z-1),r=e.min.z-128,o=n.brushes.filter(l=>l.min.x<=i&&l.max.x>=i&&l.min.y<=a&&l.max.y>=a&&l.min.z<s&&l.max.z>r),c=n.displacementTriangles?.filter(l=>Math.min(...l.vertices.map(u=>u.x))<=i&&Math.max(...l.vertices.map(u=>u.x))>=i&&Math.min(...l.vertices.map(u=>u.y))<=a&&Math.max(...l.vertices.map(u=>u.y))>=a&&Math.min(...l.vertices.map(u=>u.z))<s&&Math.max(...l.vertices.map(u=>u.z))>r),d=new @W(o,c).trace({x:i,y:a,z:s},{x:i,y:a,z:r},{min:{x:0,y:0,z:0},max:{x:0,y:0,z:0}});return d.brush&&!d.startSolid&&d.normal.z>.5?e.kind==="start"?d.end.z:Math.max(e.min.z,d.end.z):e.min.z}',
    edits: [['r=e.min.z-128,o=n.brushes.filter', 'r=e.min.z-128,__qolFloor=__qolZoneFloorCandidates(__qolFloorWorlds.get(n.brushes),n,i,a,r,s),o=(__qolFloor?.brushes??n.brushes).filter']]},
];

export function nativeMapFloorHooks(source, contract) {
  if (!contract) return source;
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tree = contract.signature.match(/class ([\w$]+)\{constructor\([\w$]+,[\w$]+=12\)/)?.[1];
  const brushes = contract.signature.match(new RegExp(`class ${escape(contract.name)}\\{constructor\\(([\\w$]+),`))?.[1];
  if (!tree || !brushes) return source;
  const ending = `this.tree=new ${tree}([...${brushes},...this.triangleBounds])}`;
  if (!source.includes(ending) || source.indexOf(ending) !== source.lastIndexOf(ending)) return source;
  for (const floor of floors) {
    const pattern = new RegExp(escape(floor.text).replace('@F', '[\\w$]+').replace('@T', '[\\w$]+').replace('@W', escape(contract.name)), 'g');
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) continue;
    let replacement = matches[0][0].replace('c=n.displacementTriangles?.filter', 'c=(__qolFloor?__qolFloor.triangles:n.displacementTriangles)?.filter');
    for (const [from, to] of floor.edits) replacement = replacement.replace(from, to);
    source = source.slice(0, matches[0].index) + replacement + source.slice(matches[0].index + matches[0][0].length);
    return source.replace(ending, `this.tree=new ${tree}([...${brushes},...this.triangleBounds]);__qolFloorWorlds.set(${brushes},this)}`);
  }
  return source;
}
