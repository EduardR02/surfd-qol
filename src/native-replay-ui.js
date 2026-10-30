// Native owns replay physics, scrubbing and playback shortcuts. This layer only
// adds annotations/tools, or opts into our existing bar without restarting it.
import {createReplayBar, timelineMarks, markTip, bindAction, pointerCode, createWheelGate, keyRows} from './replay-bar.js';
import {savelocBinds} from './key-names.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
export const nativeExtrasMarkup = `<section id="native-replay-extras" class="nr" aria-label="Replay extras" hidden>
  <div class="nr-marks"></div>
  <div class="nr-tools"><span class="nr-notice" role="status"></span><button type="button" data-extra="save">Saveloc</button><button type="button" data-extra="keys" aria-label="Saveloc shortcuts" aria-expanded="false">Keys</button><button type="button" data-extra="runs" aria-controls="runs-panel" aria-expanded="false">Runs</button></div>
  <div class="nr-keys rb-pop rb-sheet" hidden></div><div class="nr-tip rb-tip" hidden></div>
</section>`;
export const nativeExtrasStyles = `
.nr{--ink:rgba(18,18,18,.94);position:fixed;pointer-events:none;color:var(--paper);font-size:12px;z-index:1}
.nr-tools{position:absolute;right:0;bottom:25px;display:flex;align-items:center;gap:5px;max-width:100%;pointer-events:auto}
.nr-tools button{font-family:inherit;font-weight:700;font-size:12px;color:var(--paper);border:1px solid #ffffff30;border-radius:8px;padding:6px 10px;background:rgba(18,18,18,.88);cursor:pointer;white-space:nowrap}
.nr-tools button:hover,.nr-tools button[aria-expanded=true]{border-color:var(--accent)}
.nr :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.nr-notice{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 1px 3px #000;min-width:0}
.nr-marks{position:absolute;inset:0;pointer-events:none}
.nr-mark{position:absolute;top:-5px;width:12px;height:14px;margin-left:-6px;padding:0;border:0;background:none;pointer-events:auto;cursor:pointer}
.nr-mark::before{content:"";display:block;margin:auto;width:3px;height:12px;background:var(--muted);box-shadow:0 0 0 1px #080808b8;transform:skewX(-20deg)}
.nr-mark.good::before{background:var(--good)}.nr-mark.warn::before{background:var(--warn)}.nr-mark.loss::before{background:var(--bad)}
.nr-mark.loc{top:-22px;height:20px;width:20px;margin-left:-10px}
.nr-mark.loc::before{width:7px;height:7px;background:#f2f2f2;transform:rotate(45deg)}
.nr-mark.sel::before{box-shadow:0 0 0 1px #080808b8,0 0 0 3px #ffffff60}
.nr-tip{bottom:55px;max-width:calc(100vw - 32px);box-sizing:border-box}
.nr-keys{bottom:62px;right:0;pointer-events:auto;box-sizing:border-box;max-width:calc(100vw - 28px)}
@media(max-width:600px){.nr-tools{gap:4px}.nr-tools button{padding:5px 8px}.nr-notice{font-size:11px}}
`;

// One route for game-configured saveloc binds, independent of which UI is up.
// Playback keys deliberately have no extension mapping.
function replaySavelocAction(control, action) {
  if (action === 'save') control.saveSpot();
  else if (action === 'load') control.goToSpot();
  else if (action === 'previousSave') control.cycleSpot(-1);
  else if (action === 'nextSave') control.cycleSpot(1);
}

// Consumes both halves of a loc bind so the game cannot also act on it, but
// returns an action only on its first press / first wheel event of a burst.
export function createReplayBindRouter(now = () => performance.now()) {
  const wheelGate = createWheelGate();
  return (event, binds) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return null;
    const keyboard = event.type === 'keydown' || event.type === 'keyup';
    const action = bindAction(binds, keyboard ? event.code : pointerCode(event));
    if (!action) return null;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type === 'keyup' || event.type === 'mouseup' || event.repeat) return null;
    if (event.type === 'wheel' && !wheelGate(now())) return null;
    return action;
  };
}

export function createReplayUi(options) {
  const {root, host, control, getBindings = () => null, getCustom = () => false, getCinema = () => false, onRuns, getKind} = options;
  const custom = createReplayBar(options);
  const extras = root.getElementById('native-replay-extras');
  const marksLayer = extras.querySelector('.nr-marks'), notice = extras.querySelector('.nr-notice');
  const tools = extras.querySelector('.nr-tools');
  const runs = extras.querySelector('[data-extra="runs"]'), keys = extras.querySelector('[data-extra="keys"]');
  const save = extras.querySelector('[data-extra="save"]');
  const sheet = extras.querySelector('.nr-keys'), tip = extras.querySelector('.nr-tip');
  // The custom bar replaces the game's. The game lifts its chat, toasts and
  // key display just clear of its own one-row bar; ours has two rows.
  const suppress = document.createElement('style');
  suppress.textContent = '#replay-transport{display:none!important}' +
    '.replay-watching #community-chat,.replay-watching #toast{bottom:124px!important}' +
    '.replay-watching #telemetry{bottom:max(12%,124px)!important}';
  suppress.disabled = true;
  document.head.append(suppress);
  let transport = null, status = null, customMode = false, available = false, reserve = 0;
  let drawn = null, geometry = '', marks = [], sheetOpen = false;
  const routeBind = createReplayBindRouter();
  const bindings = () => savelocBinds(getBindings());
  const hideExtras = () => {
    if (extras.hidden) return;
    extras.hidden = true; tip.hidden = true; sheet.hidden = true; sheetOpen = false;
    keys.setAttribute('aria-expanded', 'false');
  };
  function showSheet() {
    sheetOpen = !sheetOpen;
    sheet.hidden = !sheetOpen;
    keys.setAttribute('aria-expanded', String(sheetOpen));
    if (sheetOpen) sheet.innerHTML = `<dl>${keyRows(bindings()).map(([key, label, loc]) => `<dt${loc ? ' class="loc"' : ''}>${escape(key)}</dt><dd>${escape(label)}</dd>`).join('')}</dl><p>Saved locations become practice savelocs when you leave the replay.</p>`;
  }
  function paint() {
    // Check visibility before status(): hidden extras must not request analysis.
    if (!available || customMode || !transport || transport.hidden || transport.classList.contains('rt-idle')) { hideExtras(); return; }
    const next = control.status();
    if (!next) { status = null; hideExtras(); return; }
    status = next;
    const track = transport.querySelector('.rt-track');
    if (!track) { hideExtras(); return; }
    const rect = track.getBoundingClientRect(), nativeRect = transport.getBoundingClientRect();
    const shape = `${rect.left},${rect.top},${rect.width},${rect.height}`;
    if (shape !== geometry) {
      geometry = shape;
      extras.style.left = `${rect.left}px`; extras.style.top = `${rect.top}px`;
      extras.style.width = `${rect.width}px`; extras.style.height = `${rect.height}px`;
    }
    reserve = innerHeight - Math.min(nativeRect.top, rect.top - 57) + 16;
    const signature = [next.length, next.lastSpot, next.start, next.ramps, next.ramps?.length, ...(next.spots ?? [])];
    if (!drawn || signature.length !== drawn.length || signature.some((value, index) => value !== drawn[index])) {
      drawn = signature;
      marks = timelineMarks(next, getKind?.(next)).filter(mark => mark.type === 'ramp' || mark.type === 'loc');
      marksLayer.innerHTML = marks.map((mark, index) => `<button type="button" class="nr-mark ${mark.type === 'loc' ? `loc${mark.selected ? ' sel' : ''}` : mark.tone}" data-mark="${index}" style="left:${mark.at * 100}%" aria-label="${escape(mark.label)}${mark.type === 'loc' ? '. Right-click removes it.' : ''}"></button>`).join('');
    }
    if (notice.textContent !== (next.notice ?? '')) notice.textContent = next.notice ?? '';
    // Compare's moments aren't the played run's alone, so it keeps no savelocs.
    const comparing = getCinema() === true || next.ghosts === true;
    if (save.hidden !== comparing) { save.hidden = keys.hidden = comparing; if (comparing && sheetOpen) showSheet(); }
    extras.hidden = false;
  }
  // The HUD's 67 ms lifecycle tick is enough for static annotations; native
  // playback paints its own progress independently, with no second frame loop.
  function refresh() { if (!customMode) paint(); }
  extras.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const mark = marks[Number(button.dataset.mark)];
    if (button.hasAttribute('data-mark') && mark) {
      if (mark.type === 'loc') control.goToSpot(mark.tick); else control.seek(mark.tick);
    } else if (button.dataset.extra === 'save') control.saveSpot();
    else if (button.dataset.extra === 'runs') onRuns?.(tools.getBoundingClientRect());
    else if (button.dataset.extra === 'keys') showSheet();
    refresh();
  });
  marksLayer.addEventListener('contextmenu', event => {
    const button = event.target.closest('[data-mark]'), mark = button && marks[Number(button.dataset.mark)];
    if (mark?.type !== 'loc') return;
    event.preventDefault(); control.removeSpot(mark.tick); tip.hidden = true; refresh();
  });
  marksLayer.addEventListener('pointerover', event => {
    const button = event.target.closest('[data-mark]'), mark = button && marks[Number(button.dataset.mark)];
    if (!mark || !status) return;
    const content = markTip(mark, status);
    tip.innerHTML = `<b class="t-title">${escape(content.title)}</b><b class="t-val ${content.tone}">${escape(content.value)}</b><span class="t-lab">${escape(content.label)}</span>`;
    tip.hidden = false;
    const half = tip.offsetWidth / 2, width = extras.clientWidth;
    tip.style.left = `${Math.max(half, Math.min(width - half, mark.at * width))}px`;
  });
  marksLayer.addEventListener('pointerout', () => { tip.hidden = true; });
  function ignores(event) {
    const origin = event.composedPath()[0];
    return event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
      origin instanceof Element && !!origin.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"],#runs-panel,#panel');
  }
  return {
    get visible() { return available && (customMode ? custom.visible : !!transport && !transport.hidden); },
    get status() { return customMode ? custom.status : status; },
    render(inSurf) {
      available = inSurf;
      customMode = getCustom() === true;
      transport = document.getElementById('replay-transport');
      // Service replay exit even in menus: saved moments must reach the
      // practice bank before the player resumes or opens Load position.
      const active = control.active;
      const nativeHidden = customMode && active;
      if (suppress.disabled === nativeHidden) suppress.disabled = !nativeHidden;
      if (customMode) { hideExtras(); return custom.render(inSurf); }
      custom.render(false);
      if (!inSurf || !transport || transport.hidden) { hideExtras(); status = null; reserve = 0; return 0; }
      // Idle is a cheap lifecycle check only; no geometry or analysis polling.
      if (transport.classList.contains('rt-idle')) { hideExtras(); return reserve; }
      refresh();
      return reserve;
    },
    setRunsOpen(value) {
      custom.setRunsOpen(value);
      if (runs.getAttribute('aria-expanded') !== String(value)) runs.setAttribute('aria-expanded', String(value));
    },
    handleKey(event) {
      custom.handleKey(event);
      if (!available || !control.active || ignores(event)) return;
      if (event.code === 'Escape' && sheetOpen) {
        event.preventDefault(); event.stopImmediatePropagation(); if (event.type === 'keydown') showSheet(); return;
      }
      if (getCinema() === true) return;
      const action = routeBind(event, bindings());
      if (action) { replaySavelocAction(control, action); refresh(); }
    },
    handlePointer(event) {
      if (!available || !control.active || ignores(event)) return;
      if (event.composedPath().includes(host) || event.composedPath().some(node => node === transport) || getCinema() === true) return;
      const action = routeBind(event, bindings());
      if (action) { replaySavelocAction(control, action); refresh(); }
    },
    showPopover(name) { if (customMode) custom.showPopover(name); else if (name === 'keys' && !extras.hidden && !sheetOpen) showSheet(); },
    anchor() { return (customMode ? root.getElementById('replay') : tools).getBoundingClientRect(); },
    destroy() { hideExtras(); custom.destroy(); suppress.remove(); },
  };
}
