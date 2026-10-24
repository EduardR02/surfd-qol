// Replay controls, shown along the bottom while any replay plays: yours, or
// someone else's started from the game's own Watch buttons. Three rows: what
// you're watching and whether it plays, the transport with a labelled
// timeline. Every shortcut is listed under Keys.
import {formatTime} from './hud-model.js';
import {SPEEDS} from './replay-control.js';

const icon = path => `<svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg>`;
const PLAY = icon('<path d="M5 3.2v9.6L12.6 8z" class="fill"/>');
const PAUSE = icon('<path d="M4.5 3h2.4v10H4.5zM9.1 3h2.4v10H9.1z" class="fill"/>');
const escape = value => String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
// Timeline labels need room; past this many they'd overlap.
const MAX_LABELS = 8;
export const replayBarMarkup = `
<section id="replay-bar" class="replay-bar" aria-label="Replay controls" hidden>
  <div id="rb-help" class="rb-help" hidden>
    <h4>Replay keys</h4>
    <dl id="rb-help-list"></dl>
  </div>
  <div class="rb-head">
    <span id="rb-title" class="rb-title"></span>
    <span id="rb-state" class="rb-state" role="status"></span>
    <button id="rb-keys" class="rb-link" type="button" aria-expanded="false" aria-controls="rb-help">Keys</button>
  </div>
  <div class="rb-row">
    <button id="rb-back" class="rb-button" type="button" title="Back 5 seconds (←)">−5 s</button>
    <button id="rb-play" class="rb-button rb-play" type="button" aria-label="Play">${PLAY}</button>
    <button id="rb-forward" class="rb-button" type="button" title="Forward 5 seconds (→)">+5 s</button>
    <span id="rb-time" class="rb-time"></span>
    <div class="rb-track">
      <div id="rb-markers" class="rb-markers" aria-hidden="true"></div>
      <input id="rb-scrub" class="rb-scrub" type="range" min="0" max="1" step="1" value="0" aria-label="Position in the replay">
      <div id="rb-labels" class="rb-labels" aria-hidden="true"></div>
    </div>
    <span class="rb-speed-label" id="rb-speed-label">Speed</span>
    <span class="rb-speeds" role="radiogroup" aria-labelledby="rb-speed-label">${
      SPEEDS.map(speed => `<button type="button" role="radio" aria-checked="false" data-speed="${speed}">${speed}×</button>`).join('')
    }</span>
  </div>
</section>`;

export const replayBarStyles = `
.replay-bar{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);width:min(880px,calc(100vw - 32px));pointer-events:auto;
  padding:9px 14px 10px;border:1px solid rgba(255,232,226,.16);border-radius:14px;background:rgba(27,22,23,.88);
  -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);box-shadow:0 14px 40px rgba(0,0,0,.45);
  color:#f5ede9;font-size:13px;line-height:1.3;text-shadow:none;-webkit-text-stroke:0;font-variant-numeric:tabular-nums}
.replay-bar button{font:inherit;color:inherit;cursor:pointer}
.replay-bar :is(button,input):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.replay-bar kbd{display:inline-block;min-width:18px;margin-left:7px;padding:1px 5px;border:1px solid rgba(255,236,232,.2);border-bottom-width:2px;
  border-radius:5px;font:inherit;font-size:11px;font-weight:700;line-height:1.3;text-align:center;color:#f5ede9;background:rgba(255,236,232,.06)}
.replay-bar kbd:empty{display:none}

.rb-head{display:flex;align-items:center;gap:12px;margin:0 2px 8px}
.rb-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;font-size:13px}
.rb-state{flex:none;font-size:12.5px;color:#c4b7b2}
.rb-state.playing{color:var(--good)}
.rb-link{flex:none;padding:3px 9px;border:1px solid rgba(255,232,226,.16);border-radius:7px;background:none;font-size:12px;font-weight:700;color:#c4b7b2}
.rb-link:hover,.rb-link[aria-expanded=true]{color:#f5ede9;border-color:color-mix(in srgb,var(--accent) 60%,transparent)}

.rb-row{display:flex;align-items:center;gap:8px}
.rb-button{flex:none;height:32px;min-width:44px;padding:0 10px;border:1px solid rgba(255,232,226,.16);border-radius:9px;background:transparent;
  font-size:12.5px;font-weight:700;color:#c4b7b2}
.rb-button:hover{color:#f5ede9;border-color:color-mix(in srgb,var(--accent) 60%,transparent)}
.rb-play{width:40px;min-width:40px;padding:0;display:grid;place-items:center;border-color:transparent;background:var(--accent);color:#211b1c}
.rb-play:hover{color:#211b1c;filter:brightness(1.08)}
.rb-play svg{width:16px;height:16px}.rb-play .fill{fill:currentColor}
.rb-time{flex:none;min-width:146px;text-align:center;font-size:13px;color:#998c87}
.rb-time b{color:#f5ede9;font-weight:700}
.rb-track{position:relative;flex:1 1 auto;min-width:140px;height:40px}
.rb-markers{position:absolute;left:8px;right:8px;top:8px;height:12px;pointer-events:none}
.rb-markers i{position:absolute;top:0;width:2px;height:12px;margin-left:-1px;border-radius:1px;background:rgba(255,236,232,.55)}
.rb-markers i.start{background:var(--good)}
.rb-scrub{position:absolute;left:0;top:0;width:100%;height:28px;margin:0;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer}
.rb-scrub::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:linear-gradient(90deg,var(--accent) var(--fill,0%),rgba(255,236,232,.16) var(--fill,0%))}
.rb-scrub::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#f5ede9;box-shadow:0 0 0 3px #231d1e,0 1px 3px rgba(0,0,0,.5)}
.rb-labels{position:absolute;left:8px;right:8px;top:26px;height:12px;pointer-events:none}
.rb-labels span{position:absolute;transform:translateX(-50%);font-size:10px;font-weight:700;color:#998c87;white-space:nowrap}
.rb-labels span.start{color:var(--good)}
.rb-speed-label{flex:none;margin-left:4px;font-size:12px;color:#998c87}
.rb-speeds{flex:none;display:inline-flex;padding:3px;gap:2px;border-radius:9px;background:rgba(0,0,0,.28);box-shadow:inset 0 0 0 1px rgba(255,232,226,.085)}
.rb-speeds button{padding:4px 7px;border:0;border-radius:6px;background:none;font-size:12px;font-weight:700;color:#998c87}
.rb-speeds button:hover{color:#c4b7b2}
.rb-speeds button[aria-checked=true]{background:#3d3334;color:#f5ede9}

.rb-help{position:absolute;right:0;bottom:calc(100% + 8px);width:340px;padding:12px 14px;border:1px solid rgba(255,232,226,.16);border-radius:12px;
  background:rgba(27,22,23,.94);box-shadow:0 14px 40px rgba(0,0,0,.45)}
.rb-help h4{margin:0 0 8px;font-size:12px;font-weight:700;color:#c4b7b2}
.rb-help dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0;align-items:center}
.rb-help dt{text-align:right;white-space:nowrap}
.rb-help dt kbd{margin:0 0 0 3px}
.rb-help dd{margin:0;font-size:12.5px;color:#c4b7b2}

@media (max-width:760px){
  .rb-state{display:none}
  .rb-row{flex-wrap:wrap}
  .rb-track{order:5;flex-basis:100%}
  .rb-time{min-width:0;margin-left:auto}
  .rb-speed-label{display:none}
  .rb-help{width:auto;left:0}
}
`;

export function createReplayBar({root, control}) {
  const node = id => root.getElementById(id);
  const bar = node('replay-bar'), play = node('rb-play'), scrub = node('rb-scrub'), time = node('rb-time');
  const title = node('rb-title'), state = node('rb-state'), markers = node('rb-markers'), labels = node('rb-labels');
  const help = node('rb-help'), helpList = node('rb-help-list'), keysButton = node('rb-keys');
  const speeds = [...bar.querySelectorAll('[data-speed]')];
  let dragging = false, pendingSeek = null, frame = 0, markerKey = '', helpKey = '';
  const write = (element, value, html = false) => {
    if (html ? element.innerHTML !== value : element.textContent !== value) html ? element.innerHTML = value : element.textContent = value;
  };
  const clock = (status, index) => formatTime(Math.max(0, (index - status.start) * status.dt));

  // Keep clicks, drags and wheel turns on the bar away from the game's own handlers.
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu']) {
    bar.addEventListener(type, event => event.stopPropagation());
  }
  play.addEventListener('click', () => { control.toggle(); render(); });
  node('rb-back').addEventListener('click', () => { control.skip(-5); render(); });
  node('rb-forward').addEventListener('click', () => { control.skip(5); render(); });
  for (const button of speeds) button.addEventListener('click', () => { control.setSpeed(Number(button.dataset.speed)); render(); });
  keysButton.addEventListener('click', () => {
    help.hidden = !help.hidden;
    keysButton.setAttribute('aria-expanded', String(!help.hidden));
    render();
  });
  // Dragging seeks live, at most once a frame, to the latest position.
  scrub.addEventListener('input', () => {
    dragging = true;
    pendingSeek = scrub.valueAsNumber;
    const status = control.status();
    if (status) write(time, `<b>${clock(status, pendingSeek)}</b> / ${clock(status, status.length)}`, true);
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      if (pendingSeek !== null) { control.seek(pendingSeek); pendingSeek = null; }
    });
  });
  scrub.addEventListener('change', () => {
    dragging = false;
    if (pendingSeek !== null) { control.seek(pendingSeek); pendingSeek = null; }
    render();
  });

  function render(visible = true) {
    const status = visible ? control.status() : null;
    if (bar.hidden !== !status) bar.hidden = !status;
    if (!status) return 0;
    write(title, status.title);
    write(state, status.ended ? 'Finished · press Play to watch again' : status.playing ? status.speed === 1 ? 'Playing' : `Playing at ${status.speed}×` : 'Paused');
    state.classList.toggle('playing', status.playing);
    const label = status.playing ? 'Pause (Space)' : status.ended ? 'Watch again from the start (Space)' : 'Play (Space)';
    if (play.getAttribute('aria-label') !== label) {
      play.setAttribute('aria-label', label);
      play.title = label;
      play.innerHTML = status.playing ? PAUSE : PLAY;
    }
    scrub.max = String(status.length);
    if (!dragging) {
      scrub.value = String(status.index);
      write(time, `<b>${clock(status, status.index)}</b> / ${clock(status, status.length)}`, true);
    }
    scrub.style.setProperty('--fill', `${(Number(scrub.value) / Math.max(1, status.length)) * 100}%`);

    // Timeline: the start and checkpoints as ticks with labels.
    const at = index => `${(index / Math.max(1, status.length)) * 100}%`;
    const key = `${status.length}:${status.start}:${status.markers.join(',')}`;
    if (key !== markerKey) {
      markerKey = key;
      markers.innerHTML = `<i class="start" style="left:${at(status.start)}"></i>` +
        status.markers.map(index => `<i style="left:${at(index)}"></i>`).join('');
      labels.innerHTML = status.markers.length + 1 > MAX_LABELS ? '' :
        `<span class="start" style="left:${at(status.start)}">Start</span>` +
        status.markers.map((index, n) => `<span style="left:${at(index)}">CP${n + 1}</span>`).join('');
    }

    // Keys list.
    if (!help.hidden) {
      const rows = [
        [['Space'], 'Play / pause'], [['ArrowLeft', 'ArrowRight'], 'Back / forward 5 seconds'],
        [['Comma', 'Period'], 'Step one tick back / forward (pauses)'], [['BracketLeft', 'BracketRight'], 'Slower / faster'],
        [['Escape'], 'Stop; press again for the menu'],
      ];
      const names = {Comma: ',', Period: '.', BracketLeft: '[', BracketRight: ']', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc'};
      const html = rows.map(([codes, text]) => `<dt>${codes.map(code => `<kbd>${escape(names[code] ?? code)}</kbd>`).join('')}</dt><dd>${text}</dd>`).join('');
      if (html !== helpKey) { helpKey = html; helpList.innerHTML = html; }
    }
    for (const button of speeds) {
      const checked = String(Number(button.dataset.speed) === status.speed);
      if (button.getAttribute('aria-checked') !== checked) button.setAttribute('aria-checked', checked);
    }
    // Height the HUD should keep clear at the bottom of the screen.
    return Math.ceil(bar.offsetHeight + 20);
  }

  const keys = {
    Space: () => control.toggle(), ArrowLeft: () => control.skip(-5), ArrowRight: () => control.skip(5),
    Comma: () => control.step(-1), Period: () => control.step(1), BracketLeft: () => control.slower(), BracketRight: () => control.faster(),
  };
  // Typing in a text field (e.g. the game's chat) never triggers replay keys.
  const typing = event => {
    const target = event.composedPath()[0];
    return target?.isContentEditable || (target?.tagName === 'INPUT' && target.type !== 'range') || target?.tagName === 'TEXTAREA';
  };
  return {
    render,
    // Capture-phase key handler; consumes only its own keys, and only while a replay is up.
    handleKey(event) {
      const run = bar.hidden || event.ctrlKey || event.metaKey || event.altKey || typing(event) ? null : keys[event.code];
      if (!run) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'keydown' && (!event.repeat || event.code !== 'Space')) { run(); render(); }
    },
    // Dev harness hook.
    showKeys() { help.hidden = false; keysButton.setAttribute('aria-expanded', 'true'); render(); },
    destroy() { cancelAnimationFrame(frame); },
  };
}
