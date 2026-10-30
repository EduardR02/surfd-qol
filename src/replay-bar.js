// Opt-in custom replay bar. It is drawn on the scene the way
// the HUD is, over a soft pool of shade instead of a box: one line with Play,
// the timeline and a few tools. The timeline is the run itself: the start,
// each checkpoint, every ramp board graded in the HUD's colours, and your
// locs. Left alone while playing, everything but the timeline fades out.
import {SPEEDS} from './replay-control.js';
import {formatTime, formatDelta} from './hud-model.js';
import {bindLabel, savelocBinds} from './key-names.js';

const REST_MS = 2600;
const WHEEL_MS = 150;
const SNAP_PX = 7;
const BIND_ACTIONS = ['save', 'load', 'previousSave', 'nextSave'];
// Native document shortcuts own playback in both presentation modes.
const TONES = new Set(['good', 'warn', 'loss', 'muted']);
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

// Run time: negative while the replay is still before the start, never −0.
export function railTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  return Math.round(seconds * 1000) < 0 ? `−${formatTime(-seconds)}` : formatTime(Math.max(0, seconds));
}
// The saveloc action a key, mouse button or wheel code is bound to, if any.
export const bindAction = (binds, code) => code ? BIND_ACTIONS.find(action => binds[action]?.includes(code)) ?? null : null;
// The bind code of a window mousedown, mouseup or wheel event: Mouse0..Mouse4, WheelUp, WheelDown.
export const pointerCode = event => event.type === 'wheel' ? (event.deltaY < 0 ? 'WheelUp' : event.deltaY > 0 ? 'WheelDown' : null) : `Mouse${event.button}`;
// One wheel notch arrives as several events: the gate opens for the first of each burst.
export function createWheelGate(ms = WHEEL_MS) {
  let last = -Infinity;
  return time => { const quiet = time - last > ms; last = time; return quiet; };
}
const speedText = speed => `${String(speed).replace(/^0\./, '.')}×`;

const sameList = (a = [], b = []) => a === b || (a.length === b.length && a.every((value, index) => value === b[index]));

// Everything drawn on the timeline, in ticks: the start, checkpoints, ramp
// boards and locs. Positions are fractions of the replay. Stage maps ('S')
// name their markers by the stage they open.
export function timelineMarks(status, kind = 'CP') {
  const length = Math.max(1, status.length), at = tick => Math.max(0, Math.min(1, tick / length));
  const playable = tick => Number.isFinite(tick) && tick >= 0 && tick <= status.length;
  const marks = [];
  if (status.start > 0 && playable(status.start)) marks.push({type: 'start', tick: status.start, at: at(status.start), label: 'Start'});
  (status.markers ?? []).forEach((tick, index) => { if (playable(tick)) marks.push({type: 'cp', tick, at: at(tick), label: kind === 'S' ? `Stage ${index + 2}` : `CP${index + 1}`}); });
  for (const ramp of status.ramps ?? []) {
    if (playable(ramp.tick)) marks.push({type: 'ramp', tick: ramp.tick, at: at(ramp.tick), label: ramp.label, board: ramp.board, tone: TONES.has(ramp.tone) ? ramp.tone : 'muted'});
  }
  (status.spots ?? []).forEach((tick, index) => { if (playable(tick)) marks.push({type: 'loc', tick, at: at(tick), label: `Loc ${index + 1}`, selected: tick === status.lastSpot}); });
  return marks;
}
// What hovering a mark (or a bare point of the timeline) says.
export function markTip(mark, status) {
  const time = tick => railTime((tick - status.start) * status.dt);
  if (!mark) return {title: '', value: time(status.hover ?? 0), label: '', tone: ''};
  if (mark.type === 'ramp') {
    const known = Number.isFinite(mark.board);
    return {title: mark.label, value: known ? formatDelta(-mark.board, 1) : '—', label: 'touch', tone: known ? mark.tone : 'muted'};
  }
  return {title: mark.label, value: time(mark.tick), label: mark.type === 'loc' ? 'right-click removes' : '', tone: mark.type === 'loc' ? 'loc' : ''};
}

// The keyboard sheet: our keys, then the game's saveloc binds as they are set.
export function keyRows(binds) {
  const rows = [['Space', 'Play or pause'], ['← →', 'Back or forward 5 s'], [', .', 'Back or forward one tick'], ['[ ]', 'Slower or faster']];
  const locs = [['save', 'Save a loc'], ['load', 'Go to the selected loc'], ['previousSave', 'Previous loc'], ['nextSave', 'Next loc']];
  for (const [action, text] of locs) { const label = bindLabel(binds[action]); if (label) rows.push([label, text, true]); }
  rows.push(['Esc', 'Game menu']);
  return rows;
}

const svg = body => `<svg viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`;
const ICONS = {
  play: svg('<path d="M6.6 3.9v12.2c0 .6.6.9 1.1.6l9.4-6.1a.7.7 0 0 0 0-1.2L7.7 3.3c-.5-.3-1.1 0-1.1.6z"/>'),
  pause: svg('<path d="M5 3.5h3.5v13H5zM11.5 3.5H15v13h-3.5z"/>'),
  again: svg('<path d="M10 3.6a6.4 6.4 0 1 1-6.2 8 1 1 0 0 1 1.9-.5A4.4 4.4 0 1 0 10 5.6H8.6l1.6 1.6a1 1 0 0 1-1.4 1.4L5.5 5.3a1 1 0 0 1 0-1.4L8.8.6a1 1 0 0 1 1.4 1.4L8.6 3.6z"/>'),
  keys: svg('<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M2.8 5.6h14.4v8.8H2.8z"/><path d="M5 7.6h1.7v1.6H5zm3 0h1.7v1.6H8zm3 0h1.7v1.6H11zm3 0h1.4v1.6H14zM6.5 11h7v1.6h-7z"/>'),
  runs: svg('<path d="M4.4 4.5h2.8L5.6 8H2.8zm0 3.8M8.5 5.1h8.7v2.2H8.5zM4 10.3h2.8l-1.6 3.5H2.4zM8.5 10.9h8.7v2.2H8.5z"/>'),
};

export const replayBarMarkup = `
<section id="replay" class="rb" aria-label="Replay controls" hidden>
  <button class="rb-btn rb-play" type="button" data-act="toggle" aria-label="Pause">${ICONS.pause}</button>
  <div class="rb-line">
    <div class="rb-rail" role="slider" tabindex="0" aria-label="Replay position" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
      <div class="rb-track"></div>
      <div class="rb-marks" aria-hidden="true"></div>
      <div class="rb-headway" aria-hidden="true"><i class="rb-head"></i></div>
      <div class="rb-indexed" aria-hidden="true"></div>
    </div>
    <div class="rb-pins"></div>
    <div class="rb-tip" aria-hidden="true" hidden><b class="t-title"></b><b class="t-val"></b><span class="t-lab"></span></div>
  </div>
  <span class="rb-side">
    <span class="rb-total" data-rb="total"></span>
    <span class="rb-tools">
      <button class="rb-btn rb-speed" type="button" data-pop="speed" aria-haspopup="true" aria-expanded="false" aria-label="Playback speed" title="Playback speed ( [ and ] )">1×</button>
      <button class="rb-btn rb-save" type="button" data-act="save" title="Save a location here (see Keyboard shortcuts for your keys)">Saveloc</button>
      <button class="rb-btn rb-icon" type="button" data-pop="keys" aria-haspopup="true" aria-expanded="false" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">${ICONS.keys}</button>
      <button class="rb-runs" type="button" data-act="runs" aria-expanded="false" aria-controls="runs-panel" title="Your runs on this map">${ICONS.runs}<span>Runs</span></button>
      <button class="rb-btn rb-leave" type="button" data-act="return" hidden>Return to server</button>
      <button class="rb-btn rb-leave" type="button" data-act="exit">Exit replay</button>
    </span>
  </span>
  <span class="rb-notice" data-rb="notice" role="status"></span>
  <div class="rb-pop rb-speeds" data-popover="speed" role="group" aria-label="Playback speed" hidden>
    ${SPEEDS.map(speed => `<button type="button" data-speed="${speed}" aria-pressed="false">${speedText(speed)}</button>`).join('')}
  </div>
  <div class="rb-pop rb-sheet" data-popover="keys" role="group" aria-label="Keyboard shortcuts" hidden></div>
</section>`;

export const replayBarStyles = `
/* Controls on one row, the timeline under them at most of the screen's width
   (like the game's own bar, short of its edges). */
.rb{--rose:var(--accent);--loc:#f2f2f2;--rb-edge:rgba(8,8,8,.78);--ink:rgba(18,18,18,.9);position:absolute;left:50%;bottom:18px;transform:translateX(-50%);
  width:min(calc(100vw - 32px),max(1248px,86vw),2400px);display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;align-items:center;row-gap:2px;column-gap:12px;
  pointer-events:auto;color:var(--paper);font-size:13px;line-height:1.2;font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"case" 1;
  -webkit-text-stroke:1.25px var(--rb-edge);paint-order:stroke fill;text-shadow:0 1px 2px rgba(0,0,0,.5);isolation:isolate}
/* No box: a pool of shade under the bar keeps it legible on snow and neon alike. */
.rb::before{content:"";position:absolute;z-index:-1;left:-14%;right:-14%;top:-64px;bottom:-26px;pointer-events:none;
  background:radial-gradient(50% 62% at 50% 66%,rgba(8,8,8,.72),rgba(8,8,8,.5) 48%,rgba(8,8,8,0));transition:opacity .4s}
:where(.rb) button{font:inherit;color:inherit;-webkit-text-stroke:inherit;paint-order:inherit;text-shadow:inherit;cursor:pointer}
.rb :focus-visible{outline:2px solid var(--rose);outline-offset:2px}
.rb svg{display:block;width:20px;height:20px;fill:currentColor;filter:drop-shadow(0 0 1px rgba(8,8,8,.9)) drop-shadow(0 1px 2px rgba(0,0,0,.45))}
.rb-btn{height:34px;min-width:34px;display:grid;place-items:center;padding:0 9px;border:0;border-radius:10px;background:transparent;font-weight:700}
.rb-btn:hover,.rb-btn[aria-expanded=true]{background:rgba(255,255,255,.14)}
.rb-play{justify-self:start;width:42px;height:42px;padding:0;border-radius:50%;background:var(--rose);color:#141414;box-shadow:0 0 0 1.5px var(--rb-edge),0 3px 10px rgba(0,0,0,.35)}
.rb-play:hover{background:var(--rose);filter:brightness(1.08)}
.rb-play svg{width:22px;height:22px;filter:none;color:#141414}

/* The timeline: one slanted segment per section of the run (lead-in, then
   start to CP1, and so on), ramp boards as graded slanted marks across it,
   locs above, checkpoint names below. */
.rb-line{position:relative;height:46px;grid-column:1/-1;grid-row:2}
.rb-rail{position:absolute;inset:0;cursor:pointer;touch-action:none;outline:none}
.rb-rail:focus-visible .rb-track{outline:2px solid var(--rose);outline-offset:5px;border-radius:4px}
.rb-track{position:absolute;left:0;right:0;top:20px;height:7px}
.rb-track span{position:absolute;top:0;bottom:0;overflow:hidden;border-radius:1.5px;transform:skewX(-20deg);background:rgba(255,255,255,.4);
  box-shadow:0 0 0 1.25px rgba(8,8,8,.62),0 2px 5px rgba(0,0,0,.35)}
.rb-track span.pre{background:rgba(255,255,255,.2)}
.rb-track i{position:absolute;inset:0;transform-origin:0 50%;transform:scaleX(0);background:var(--rose)}
.rb-line:hover .rb-track span:not(.pre){background:rgba(255,255,255,.5)}
.rb-headway{position:absolute;inset:0;pointer-events:none;transform:translateX(0)}
.rb-head{position:absolute;left:-4px;top:11px;width:8px;height:25px;border-radius:2px;background:var(--rose);transform:skewX(-20deg);
  box-shadow:0 0 0 1.5px var(--rb-edge),0 2px 8px rgba(0,0,0,.5)}
.rb-indexed{position:absolute;top:30px;left:0;height:2px;background:rgba(255,255,255,.55);pointer-events:none}
.rb-marks{position:absolute;inset:0;pointer-events:none}
.rb-marks i{position:absolute;top:15px;width:4px;height:17px;margin-left:-2px;border-radius:1px;transform:skewX(-20deg);background:var(--muted);
  box-shadow:0 0 0 1.25px rgba(8,8,8,.72)}
.rb-marks i.good{background:var(--good)}.rb-marks i.warn{background:var(--warn)}.rb-marks i.loss{background:var(--bad)}
.rb-marks span{position:absolute;top:33px;transform:translateX(-50%);font-size:10.5px;font-weight:700;letter-spacing:.05em;white-space:nowrap;opacity:.9}
.rb-marks.dense span{display:none}
.rb-pins{position:absolute;left:0;right:0;top:0;height:14px;pointer-events:none}
.rb-pins button{position:absolute;top:-5px;width:22px;height:22px;margin-left:-11px;padding:0;border:0;background:none;pointer-events:auto;display:grid;place-items:center}
.rb-pins button::before{content:"";width:8px;height:8px;background:var(--loc);transform:rotate(45deg);border-radius:1.5px;box-shadow:0 0 0 1.5px var(--rb-edge)}
.rb-pins button.sel::before{width:10px;height:10px;box-shadow:0 0 0 1.5px var(--rb-edge),0 0 0 4px rgba(255,255,255,.42)}
.rb-pins button:hover::before{transform:rotate(45deg) scale(1.25)}
.rb-tip{position:absolute;bottom:calc(100% - 2px);left:0;transform:translateX(-50%);display:flex;align-items:baseline;gap:7px;padding:6px 10px;
  border-radius:9px;background:var(--ink);-webkit-text-stroke:0;text-shadow:none;white-space:nowrap;pointer-events:none;
  box-shadow:0 0 0 1px rgba(255,255,255,.12),0 8px 22px rgba(0,0,0,.5)}
.t-title{font-size:12px;color:#c4c4c4}.t-title:empty{display:none}
.t-val{font-size:14px}.t-lab{font-size:11px;font-weight:700;color:#949494}.t-lab:empty{display:none}
.t-val.good{color:var(--good)}.t-val.warn{color:var(--warn)}.t-val.loss{color:var(--bad)}.t-val.muted{color:var(--muted)}.t-val.loc{color:var(--loc)}
.rb-total{grid-column:2;grid-row:1;font-size:13px;font-weight:700;opacity:.8}

/* Notices never resize or shift the timeline. Save binds live in the shortcut sheet. */
.rb-side{display:contents}
.rb-notice{position:absolute;bottom:calc(100% + 10px);left:50%;transform:translateX(-50%);max-width:min(320px,100%);overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:12.5px;font-weight:700;color:var(--loc)}
.rb-notice:empty{display:none}

.rb-tools{grid-column:4;grid-row:1;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:4px;max-width:calc(100vw - 150px)}
.rb-speed,.rb-save{min-width:44px;font-size:13.5px}
.rb-leave{height:28px;min-height:28px;white-space:nowrap;font-size:12px;padding-inline:7px}
.rb-speed.off{color:var(--warn)}
.rb-runs{height:34px;display:flex;align-items:center;gap:7px;margin-left:6px;padding:0 14px 0 11px;border:0;border-radius:999px;font-size:13px;font-weight:700;
  background:var(--ink);-webkit-text-stroke:0!important;text-shadow:none!important;box-shadow:0 0 0 1px rgba(255,255,255,.16),0 4px 14px rgba(0,0,0,.4)}
.rb-runs svg{width:18px;height:18px;filter:none;color:var(--rose)}
.rb-runs:hover,.rb-runs[aria-expanded=true]{box-shadow:0 0 0 1px color-mix(in srgb,var(--rose) 70%,transparent),0 4px 14px rgba(0,0,0,.4)}

.rb-pop{position:absolute;bottom:calc(100% + 12px);right:0;padding:6px;border-radius:12px;background:var(--ink);-webkit-backdrop-filter:blur(16px);
  backdrop-filter:blur(16px);-webkit-text-stroke:0;text-shadow:none;color:#eeeeee;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 14px 36px rgba(0,0,0,.55)}
.rb-speeds{display:flex;gap:2px}
.rb-speeds button{min-width:46px;padding:7px 8px;border:0;border-radius:8px;background:none;font-size:13px;font-weight:700;color:#949494;text-shadow:none;-webkit-text-stroke:0}
.rb-speeds button:hover{color:#eeeeee;background:rgba(255,255,255,.08)}
.rb-speeds button[aria-pressed=true]{color:#141414;background:var(--rose)}
.rb-sheet{width:300px;padding:12px 14px 12px}
.rb-sheet dl{display:grid;grid-template-columns:auto 1fr;gap:7px 14px;margin:0;align-items:baseline}
.rb-sheet dt{justify-self:start;font-size:11.5px;font-weight:700;padding:2px 6px 1px;border-radius:5px;background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}
.rb-sheet dt.loc{color:var(--loc);background:rgba(255,255,255,.1);box-shadow:inset 0 0 0 1px rgba(255,255,255,.3)}
.rb-sheet dd{margin:0;font-size:12.5px;color:#c4c4c4}
.rb-sheet p{margin:12px 0 0;padding-top:10px;border-top:1px solid rgba(255,255,255,.1);font-size:12px;line-height:1.45;color:#949494}
.rb-sheet .rb-diamond{display:inline-block;width:7px;height:7px;margin:0 3px;border-radius:1px;background:var(--loc);transform:rotate(45deg);vertical-align:1px}

/* At rest (playing, untouched): only the timeline stays. */
.rb>.rb-play,.rb-total,.rb-tools{transition:opacity .35s}
.rb.rest>.rb-play,.rb.rest .rb-total,.rb.rest .rb-tools{opacity:0;pointer-events:none}
.rb.rest::before{opacity:.45}
.rb.rest .rb-marks span{opacity:0}
.rb.rest .rb-pins button{pointer-events:none}

@media (max-width:1750px){.rb-runs span{display:none}.rb-runs{padding:0 9px}}
@media (prefers-reduced-motion:reduce){.rb *,.rb::before{transition:none!important}}
`;

// render(inSurf) from the HUD's 67 ms tick shows or hides the bar; while it is
// shown, one frame loop polls status() and paints only what changed.
export function createReplayBar({root, host, control, getBindings = () => null, getKind = () => 'CP', onRuns = null, held = () => false, now = () => performance.now()}) {
  const bar = root.getElementById('replay');
  const q = selector => bar.querySelector(selector);
  const play = q('.rb-play'), rail = q('.rb-rail'), track = q('.rb-track');
  const headway = q('.rb-headway'), marksLayer = q('.rb-marks'), pins = q('.rb-pins'), tip = q('.rb-tip');
  const [tipTitle, tipValue, tipLabel] = tip.children;
  const total = q('[data-rb="total"]'), notice = q('[data-rb="notice"]');
  const speedButton = q('.rb-speed'), runsButton = q('.rb-runs'), saveButton = q('[data-act="save"]');
  const indexed = q('.rb-indexed'), returnButton = q('[data-act="return"]');
  const popovers = Object.fromEntries([...bar.querySelectorAll('[data-popover]')].map(element => [element.dataset.popover, element]));
  const openers = Object.fromEntries([...bar.querySelectorAll('[data-pop]')].map(element => [element.dataset.pop, element]));
  const write = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  const attr = (element, name, value) => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };
  const toggleClass = (element, name, on) => { if (element.classList.contains(name) !== on) element.classList.toggle(name, on); };

  let status = null, frame = 0, open = null, lastActivity = now(), dragging = false, hovering = false;
  let pendingSeek = null, seekFrame = 0, marks = [], bindsKey = null, bindsAge = 0, binds = savelocBinds(null);
  let progress = -1, playState = '', speedShown = null, totalShown = '', reserve = 0, sections = [], drawn = null, ariaAge = 0;
  const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { reserve = 0; drawn = null; }) : null;
  sizes?.observe(bar);

  const wake = () => { lastActivity = now(); };
  function readBinds() {
    let value = null;
    try { value = getBindings?.(); } catch { /* unavailable */ }
    binds = savelocBinds(value);
    const key = JSON.stringify(binds);
    if (key === bindsKey) return;
    bindsKey = key;
    if (open === 'keys') sheet();
  }
  function sheet() {
    popovers.keys.innerHTML = `<dl>${keyRows(binds).map(([keys, text, loc]) => `<dt${loc ? ' class="loc"' : ''}>${escape(keys)}</dt><dd>${escape(text)}</dd>`).join('')}</dl>
      <p>Locs you save here show on the timeline as <i class="rb-diamond"></i> marks, and become practice savelocs when you leave the replay.</p>`;
  }

  // Coalesce drag requests; the native controller owns keyframed seeking.
  function seekTo(index) {
    if (!status) return;
    pendingSeek = Math.max(0, Math.min(status.reachable ?? status.length, Math.round(index)));
    paintPosition(pendingSeek);
    if (!seekFrame) seekFrame = requestAnimationFrame(flushSeek);
  }
  function flushSeek() {
    seekFrame = 0;
    if (pendingSeek == null) return;
    const target = pendingSeek;
    pendingSeek = null;
    control.seek(target);
  }
  const position = () => pendingSeek ?? status?.index ?? 0;

  function act(action) {
    if (!status) return;
    wake();
    if (action === 'toggle') control.toggle();
    else if (action === 'save') control.saveSpot();
    else if (action === 'exit') control.exit();
    else if (action === 'return') control.returnToServer();
    else if (action === 'runs') onRuns?.(bar.getBoundingClientRect());
    refresh();
  }
  // Repaints from fresh status right after an action, not on the next frame.
  function refresh() {
    try { status = control.status() ?? status; } catch { /* keep the last one */ }
    if (status) paint();
  }

  function openPopover(name) {
    if (open === name) { closePopover(); return; }
    closePopover();
    open = name;
    if (name === 'keys') sheet();
    const opener = openers[name];
    popovers[name].style.right = `${bar.clientWidth - opener.offsetLeft - opener.offsetWidth}px`;
    popovers[name].hidden = false;
    attr(opener, 'aria-expanded', 'true');
    wake();
  }
  function closePopover(focus = false) {
    if (!open) return;
    popovers[open].hidden = true;
    attr(openers[open], 'aria-expanded', 'false');
    if (focus) openers[open].focus();
    open = null;
  }

  bar.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target || !bar.contains(target)) return;
    if (target.dataset.pop) { openPopover(target.dataset.pop); return; }
    if (target.dataset.speed) { control.setSpeed(Number(target.dataset.speed)); closePopover(); refresh(); return; }
    if (target.dataset.spot) { control.goToSpot(Number(target.dataset.spot)); wake(); refresh(); return; }
    if (target.dataset.act) act(target.dataset.act);
  });
  pins.addEventListener('contextmenu', event => {
    const target = event.target.closest('[data-spot]');
    if (!target) return;
    event.preventDefault();
    control.removeSpot(Number(target.dataset.spot));
    tip.hidden = true;
    refresh();
  });
  pins.addEventListener('pointerover', event => {
    const target = event.target.closest('[data-spot]');
    if (target) showTip(marks.find(mark => mark.type === 'loc' && mark.tick === Number(target.dataset.spot)));
  });
  pins.addEventListener('pointerout', () => { if (!hovering) tip.hidden = true; });

  // Scrubbing: a press seeks (snapping to a mark under the pointer), a drag follows.
  const fractionAt = x => { const rect = rail.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - rect.left) / Math.max(1, rect.width))); };
  function nearest(x) {
    const width = rail.getBoundingClientRect().width, at = fractionAt(x);
    let best = null, distance = SNAP_PX / Math.max(1, width);
    for (const mark of marks) {
      if (mark.type === 'loc') continue;
      const gap = Math.abs(mark.at - at);
      if (gap <= distance) { best = mark; distance = gap; }
    }
    return best;
  }
  function showTip(mark, x) {
    const tick = mark ? mark.tick : fractionAt(x) * status.length;
    const content = markTip(mark, {...status, hover: tick});
    write(tipTitle, content.title);
    write(tipValue, content.value);
    write(tipLabel, content.label);
    tipValue.className = `t-val ${content.tone}`;
    tip.style.left = `${Math.max(0, Math.min(1, tick / Math.max(1, status.length))) * 100}%`;
    tip.hidden = false;
  }
  rail.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !status) return;
    event.preventDefault();
    rail.setPointerCapture?.(event.pointerId);
    dragging = true;
    bar.classList.add('drag');
    closePopover();
    wake();
    const mark = nearest(event.clientX);
    seekTo(mark ? mark.tick : fractionAt(event.clientX) * status.length);
  });
  rail.addEventListener('pointermove', event => {
    if (!status) return;
    hovering = true;
    wake();
    if (dragging) { seekTo(fractionAt(event.clientX) * status.length); showTip(null, event.clientX); return; }
    showTip(nearest(event.clientX), event.clientX);
  });
  const release = () => { dragging = false; bar.classList.remove('drag'); };
  rail.addEventListener('pointerup', release);
  rail.addEventListener('pointercancel', release);
  rail.addEventListener('pointerleave', () => { hovering = false; if (!dragging) tip.hidden = true; });

  function paintPosition(index) {
    const next = Math.round(index / Math.max(1, status.length) * 10000) / 10000;
    if (next === progress) return;
    progress = next;
    // Only the segment under the playhead changes, unless it crossed a checkpoint.
    for (const section of sections) {
      const filled = Math.round(Math.max(0, Math.min(1, (next - section.from) / Math.max(1e-6, section.to - section.from))) * 10000) / 10000;
      if (filled !== section.filled) { section.filled = filled; section.fill.style.transform = `scaleX(${filled})`; }
    }
    headway.style.transform = `translateX(${next * 100}%)`;
    // The slider's value is announced, so while playing it updates a few times a second, not every frame.
    if (status.playing && pendingSeek == null && ++ariaAge < 15) return;
    ariaAge = 0;
    attr(rail, 'aria-valuenow', String(Math.round(index)));
    attr(rail, 'aria-valuetext', railTime((index - status.start) * status.dt));
  }
  // Marks are rebuilt only when something on the timeline changed; ramps keep their array until then.
  function marksChanged() {
    const next = status, last = drawn;
    if (last && last.length === next.length && last.start === next.start && last.lastSpot === next.lastSpot && last.title === next.title &&
      last.ramps === next.ramps && last.rampCount === next.ramps?.length && sameList(last.markers, next.markers) && sameList(last.spots, next.spots)) return false;
    drawn = {length: next.length, start: next.start, lastSpot: next.lastSpot, title: next.title, ramps: next.ramps, rampCount: next.ramps?.length, markers: next.markers, spots: next.spots};
    return true;
  }
  function paintMarks() {
    if (!marksChanged()) return;
    let kind = 'CP';
    try { kind = getKind(status) ?? 'CP'; } catch { /* checkpoints */ }
    marks = timelineMarks(status, kind);
    const pct = at => `${(at * 100).toFixed(3)}%`;
    const fixed = marks.filter(mark => mark.type !== 'loc');
    const labelled = marks.filter(mark => mark.type === 'start' || mark.type === 'cp');
    // The track splits at the start and at each checkpoint.
    const cuts = [...new Set([0, ...labelled.map(mark => mark.at), 1])].sort((a, b) => a - b);
    track.innerHTML = cuts.slice(1).map((to, index) => {
      const from = cuts[index], gap = index ? 1.5 : 0, after = to < 1 ? 1.5 : 0;
      return `<span class="${index === 0 && status.start > 0 ? 'pre' : ''}" style="left:calc(${pct(from)} + ${gap}px);width:calc(${pct(to - from)} - ${gap + after}px)"><i></i></span>`;
    }).join('');
    sections = [...track.children].map((element, index) => ({from: cuts[index], to: cuts[index + 1], fill: element.firstElementChild, filled: 0}));
    progress = -1;
    marksLayer.innerHTML = fixed.filter(mark => mark.type === 'ramp').map(mark => `<i class="${mark.tone}" style="left:${pct(mark.at)}"></i>`).join('') +
      labelled.map(mark => `<span style="left:${pct(mark.at)}">${escape(mark.type === 'start' ? 'start' : mark.label)}</span>`).join('');
    // Labels closer than ~44 px would overlap; drop them all rather than some.
    const width = rail.clientWidth || 800;
    toggleClass(marksLayer, 'dense', labelled.some((mark, index) => index && (mark.at - labelled[index - 1].at) * width < 44));
    pins.innerHTML = marks.filter(mark => mark.type === 'loc').map(mark =>
      `<button type="button" class="${mark.selected ? 'sel' : ''}" data-spot="${mark.tick}" style="left:${pct(mark.at)}" aria-label="${mark.label}, ${railTime((mark.tick - status.start) * status.dt)}. Right-click removes it."></button>`).join('');
    attr(rail, 'aria-valuemax', String(status.length));
    rail.title = status.title ?? '';
  }
  function paint() {
    const reach = Math.min(1, (status.indexed ?? status.length) / Math.max(1, status.length));
    const indexedWidth = `${reach * 100}%`;
    indexed.hidden = status.complete !== false;
    if (indexed.style.width !== indexedWidth) indexed.style.width = indexedWidth;
    returnButton.hidden = !status.parked;
    // Only multi-run comparison hides watched-run practice actions.
    if (saveButton.hidden !== !!status.ghosts) {
      const focused = root.activeElement;
      saveButton.hidden = openers.keys.hidden = !!status.ghosts;
      if (status.ghosts && open === 'keys') closePopover();
      if (status.ghosts && (focused === saveButton || focused === openers.keys || popovers.keys.contains(focused))) (q('[data-cn="enable"]') ?? play).focus({preventScroll: true});
    }
    paintMarks();
    paintPosition(position());
    const state = status.ended ? 'again' : status.playing ? 'pause' : 'play';
    if (state !== playState) {
      playState = state;
      play.innerHTML = ICONS[state];
      const label = state === 'again' ? 'Play again' : state === 'pause' ? 'Pause' : 'Play';
      attr(play, 'aria-label', label);
      play.title = `${label} (Space)`;
    }
    if (status.speed !== speedShown) {
      speedShown = status.speed;
      write(speedButton, speedText(status.speed));
      toggleClass(speedButton, 'off', status.speed !== 1);
      for (const button of popovers.speed.children) attr(button, 'aria-pressed', String(Number(button.dataset.speed) === status.speed));
    }
    const length = railTime((status.length - status.start) * status.dt);
    if (length !== totalShown) { totalShown = length; write(total, length); }
    if (total.title !== (status.title ?? '')) total.title = status.title ?? '';
    write(notice, status.notice || (status.complete === false ? `Indexing ${Math.floor(reach * 100)}%` : ''));
    if (++bindsAge > 30) { bindsAge = 0; readBinds(); }
    const rest = status.playing && !dragging && !hovering && !open && !held() && !bar.contains(root.activeElement) && !status.notice && now() - lastActivity > REST_MS;
    toggleClass(bar, 'rest', rest);
  }
  function loop() {
    frame = 0;
    if (bar.hidden) return;
    let next = null;
    try { next = control.status(); } catch { /* keep going */ }
    if (!next) { hide(); return; }
    status = next;
    paint();
    frame = requestAnimationFrame(loop);
  }

  const onMove = () => { lastActivity = now(); };
  function show() {
    bar.hidden = false;
    wake();
    drawn = null;
    progress = -1;
    playState = '';
    speedShown = null;
    bindsKey = null;
    readBinds();
    window.addEventListener('pointermove', onMove, {passive: true});
    if (!frame) frame = requestAnimationFrame(loop);
  }
  function hide() {
    bar.hidden = true;
    closePopover();
    tip.hidden = true;
    dragging = hovering = false;
    status = null;
    reserve = 0;
    window.removeEventListener('pointermove', onMove);
    cancelAnimationFrame(frame);
    cancelAnimationFrame(seekFrame);
    frame = seekFrame = 0;
    pendingSeek = null;
  }

  return {
    get visible() { return !bar.hidden; },
    get status() { return status; },
    // Shows or hides the bar; returns the height the HUD keeps clear above it.
    render(inSurf) {
      if (!inSurf) { if (!bar.hidden) hide(); return 0; }
      if (bar.hidden) {
        let next = null;
        try { next = control.status(); } catch { /* unavailable */ }
        if (!next) return 0;
        status = next;
        show();
        paint();
      }
      if (!reserve) reserve = bar.offsetHeight ? bar.offsetHeight + 18 + 22 : 0;
      return reserve;
    },
    setRunsOpen(openState) {
      if (runsButton.getAttribute('aria-expanded') === String(openState)) return;
      runsButton.setAttribute('aria-expanded', String(openState));
      wake();
    },
    handleKey(event) {
      if (bar.hidden || !status || event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const origin = event.composedPath()[0];
      if (origin instanceof Element && origin.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], #runs-panel, #panel')) return;
      if (event.code === 'Escape') {
        // Esc closes an open popover first; otherwise it is the game's.
        if (!open) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.type === 'keydown') closePopover(true);
        return;
      }
      // Playback keys pass through to the game's sole document handler.
    },
    // Saveloc binds are routed by the shared native/custom presentation owner.
    // Dev harness: open a popover.
    showPopover(name) { if (!bar.hidden && popovers[name]) openPopover(name); },
    destroy() { hide(); sizes?.disconnect(); },
  };
}
