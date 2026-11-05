// PB/WR reference downloads, storage reads and analysis are first needed when
// the player leaves the start zone, never to spawn. Requests made before the
// session's first physics step wait for it, then start in the next idle
// period, so none of that work lands in the busiest part of map entry.

// A session records one command per step. One without a command list is not
// held.
export function hasStepped(session) {
  return !Array.isArray(session?.commands) || session.commands.length > 0;
}

// Returns a cancel function.
export function whenIdle(callback) {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(() => callback(), {timeout: 200});
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(callback, 0);
  return () => clearTimeout(id);
}
