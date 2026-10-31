// Trims idle time before a run from its saved replay. The game's replays
// start from an initial player state, so a trimmed replay starts from a state
// recorded before the run left the start: first the one LEAD_SECONDS before
// it (run-history.js), then the last moment of standing fully still. A trim is
// used only when re-simulating it reaches the start on the same command with
// the same position and velocity, so anything the game tracks besides that
// state (start-zone hops, for example) can't change the run; when no trim
// passes, the full replay is saved.
//
// The check simulates only from the trim point to the start, in slices with a
// yield between them, so it doesn't hold the page.
const SLICE_COMMANDS = 32;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const same = (a, b) => !!a && !!b && Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.z, b.z);

async function attempt(Session, replay, clip, {index, state}, yieldTask) {
  if (!state || !(index > 0) || index > clip.start) return null;
  const trimmed = {...replay, initialState: structuredClone(state), commands: replay.commands.slice(index)};
  const target = clip.start - index;
  try {
    const shadow = new Session(clip.map, replay.config, replay.format);
    shadow.loadReplay(trimmed);
    for (let i = 0; i <= target; i++) {
      if (i && i % SLICE_COMMANDS === 0) await yieldTask();
      if (!shadow.step(trimmed.commands[i]).includes('start')) continue;
      return i === target && same(shadow.state.position, clip.expect.position) && same(shadow.state.velocity, clip.expect.velocity)
        ? {replay: trimmed, offset: index} : null;
    }
  } catch { /* an unsupported session keeps the full replay */ }
  return null;
}

// clip: {candidates: [{index, state}], start, expect: {position, velocity}, map} from run-history.
export async function trimReplay(Session, replay, clip, {yieldTask = pause} = {}) {
  if (typeof Session !== 'function' || !clip?.map || !Array.isArray(clip.candidates)) return null;
  for (const candidate of clip.candidates) {
    const trimmed = await attempt(Session, replay, clip, candidate, yieldTask);
    if (trimmed) return trimmed;
  }
  return null;
}
