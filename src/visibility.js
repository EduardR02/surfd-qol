export function isSurfContext(snapshot, session, view, ui) {
  if (snapshot?.lobby === true || snapshot?.loading === true ||
      ui?.menuOpen === true || ui?.loading === true || ui?.finishOpen === true ||
      ui?.blockingWindowOpen === true || ui?.blockingDialogOpen === true) return false;
  if ((view ?? snapshot?.spectator)?.target != null) return true;
  if (typeof snapshot?.active === 'boolean' || typeof snapshot?.playback === 'boolean') {
    return snapshot.active === true || snapshot.playback === true;
  }
  return !!(snapshot?.state ?? session?.state) && ui?.pointerLocked === true;
}
