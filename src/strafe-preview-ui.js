// Strafe preview: the settings action that starts it, and the indicator drawn
// in the HUD's place while the camera strafes. The indicator only reacts to
// the preview's own updates, so it costs nothing while no preview runs.

export const strafePreviewMarkup = `
<section id="strafe-preview" class="hud sp" aria-label="Strafe preview" hidden>
  <div class="sp-keys"><b data-sp="A">A</b><b data-sp="D">D</b></div>
  <div class="speed" data-sp="speed">—</div>
  <div class="sp-turn"><b class="val" data-sp="turn"><span>—</span><span class="f">°/s</span></b><span class="lab">turn rate</span></div>
  <p class="lab sp-stop">Press any key to stop</p>
</section>`;

export const strafePreviewStyles = `
/* Laid out like the HUD it stands in for: the key to hold where the timer
   sits, the speed at the anchor and the turn rate where the values go. */
.sp .sp-keys{position:absolute;left:0;bottom:39px;transform:translateX(-50%);display:flex;gap:16px;font-size:28px;line-height:1}
.sp .sp-keys b{opacity:.28}
.sp .sp-keys b.on{opacity:1}
.sp .sp-turn{position:absolute;left:0;top:41px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center}
.sp .sp-stop{position:absolute;left:0;top:96px;margin:0;transform:translateX(-50%);opacity:.7}
`;

// What the indicator shows for one update from the preview.
export function indicatorModel(update) {
  if (!update?.active) return {hidden: true};
  const number = value => Number.isFinite(value) ? value.toFixed(0) : '—';
  return {hidden: false, key: update.key === 'D' ? 'D' : 'A', speed: number(update.speed), turnRate: number(update.turnRate)};
}

// Starts the preview with the saved speed and mode. Resolves to '' once it
// runs, or to the message to show when it can't start.
export async function startStrafePreview(preview, settings) {
  try {
    await preview.start({units: settings.strafePreviewUnits, mode: settings.strafePreviewMode});
    return '';
  } catch (error) {
    return error?.message || 'The preview didn’t start.';
  }
}

export function createStrafePreviewIndicator(element, preview) {
  const part = name => element.querySelector(`[data-sp="${name}"]`);
  const keys = {A: part('A'), D: part('D')}, speed = part('speed'), [turn] = part('turn').children;
  const write = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function render(update) {
    const model = indicatorModel(update);
    if (element.hidden !== model.hidden) element.hidden = model.hidden;
    if (model.hidden) return;
    for (const [name, node] of Object.entries(keys)) node.classList.toggle('on', name === model.key);
    write(speed, model.speed);
    write(turn, model.turnRate);
  }
  let unsubscribe = null;
  try { unsubscribe = preview?.subscribe?.(render) ?? null; } catch { /* no preview in this build */ }
  return {
    // The HUD's position, size and opacity, so the indicator sits where the speed does.
    place(style) { for (const [name, value] of Object.entries(style)) element.style.setProperty(name, value); },
    destroy() { if (typeof unsubscribe === 'function') unsubscribe(); unsubscribe = null; element.hidden = true; },
  };
}
