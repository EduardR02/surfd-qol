// A bonus course shares its map's id; its version is the main version plus
// "/bonus-N", with ".rM" for revisions after the first (as the game names them).
const BONUS_VERSION = /^(.+)\/bonus-([1-9][0-9]?)(?:\.r([2-9]|[1-9][0-9]+))?$/;

// The bonus number of a map version, or 0 for the main course.
export function courseOfVersion(version) {
  const match = typeof version === 'string' ? BONUS_VERSION.exec(version) : null;
  return match ? Number(match[2]) : 0;
}

export const courseOf = map => courseOfVersion(map?.version);

// The main course's version of any course of a map.
export function mainVersionOf(version) {
  const match = typeof version === 'string' ? BONUS_VERSION.exec(version) : null;
  return match ? match[1] : version;
}
