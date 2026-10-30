// Ghosts in the replay view: one row just above the replay bar, in the style
// of its own tools. This run and each added run with how far apart they are
// at this point, Add run with its picker, the matching, and Reset view once
// you've moved the camera. Names follow the ghosts in the view.
import {formatTime} from './hud-model.js';
import {boardSource, ghostSources} from './ghost-sources.js';
import {MAX_GHOSTS, colorOf} from './cinema.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';
const HINT_KEY = 'surfd-qol.ghost-hint';
const HINT_MS = 5000;

export const cinemaMarkup = `<section id="cinema" class="cn" aria-label="Ghosts" hidden>
  <div class="cn-tags"></div>
  <div class="cn-row" role="toolbar" aria-label="Runs in this replay">
    <div class="cn-runs"></div>
    <button type="button" class="cn-btn cn-add" data-cn="add" aria-haspopup="dialog" aria-expanded="false" title="Play another run of this map alongside this one">${PLUS}Add run</button>
    <div class="cn-seg" role="radiogroup" aria-label="Match runs" hidden>
      <button type="button" role="radio" data-sync="time" title="Both runs on the clock, as a race">Real time</button>
      <button type="button" role="radio" data-sync="place" title="Both runs at the same place on the route: the faster one is slowed down">Side by side</button>
    </div>
    <button type="button" class="cn-btn" data-cn="reset" title="Back to the planned camera (or double-click the view)" hidden>Reset view</button>
  </div>
  <div class="cn-pick" role="dialog" aria-label="Add a run" hidden></div>
  <p class="cn-hint">Drag to look around · Scroll to zoom · Double-click to reset</p>
</section>`;

export const cinemaStyles = `
.cn{position:fixed;inset:0;pointer-events:none;color:var(--paper);font-size:12px;z-index:1}
.cn-row{position:absolute;display:flex;align-items:center;gap:5px;max-width:calc(100vw - 340px);pointer-events:auto;transition:opacity .25s}
.cn-row.idle{opacity:0;pointer-events:none}
.cn-runs{display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden}
.cn-btn,.cn-run,.cn-seg{font-family:inherit;font-weight:700;font-size:12px;color:var(--paper);border:1px solid #ffffff30;border-radius:8px;background:rgba(18,18,18,.88);white-space:nowrap}
.cn-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 10px;cursor:pointer}
.cn-btn:hover,.cn-btn[aria-expanded=true]{border-color:var(--accent)}
.cn-btn:disabled{opacity:.45;cursor:default;border-color:#ffffff30}
.cn-btn svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.cn-run{display:inline-flex;align-items:center;gap:7px;min-width:0;padding:5px 4px 5px 9px;font-variant-numeric:tabular-nums}
.cn-run.played{padding-right:10px}
.cn-run[data-focus]{cursor:pointer}
.cn-run[data-focus]:hover{border-color:#ffffff60}
.cn-run.on{border-color:var(--run);background:color-mix(in srgb,var(--run) 16%,rgba(18,18,18,.9))}
.cn-run i{flex:none;width:4px;height:14px;border-radius:1.5px;transform:skewX(-18deg);background:var(--run)}
.cn-run b{max-width:16ch;overflow:hidden;text-overflow:ellipsis}
.cn-run .t{color:#a8a8a8;font-weight:400}
.cn-run .g{min-width:5.2ch;text-align:right}
.cn-run .g:empty{display:none}
.cn-run .g.good{color:var(--good)}.cn-run .g.loss{color:var(--bad)}
.cn-run.loading{color:#a8a8a8;padding-right:10px}
.cn-run.loading i{animation:cn-pulse 1s ease-in-out infinite alternate}
@keyframes cn-pulse{to{opacity:.3}}
.cn-x{display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:none;color:#8a8a8a;cursor:pointer}
.cn-x:hover{background:rgba(255,255,255,.1);color:var(--paper)}
.cn-x svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
.cn-seg{display:flex;padding:2px;gap:2px}
.cn-seg[hidden],.cn-btn[hidden]{display:none}
.cn-seg button{font:inherit;color:#a8a8a8;border:0;border-radius:6px;padding:4px 9px;background:none;cursor:pointer}
.cn-seg button:hover{color:var(--paper)}
.cn-seg button[aria-checked=true]{background:rgba(255,255,255,.14);color:var(--paper)}
.cn-seg button[aria-busy=true]{opacity:.6}
.cn :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cn-pick{position:absolute;width:300px;max-width:calc(100vw - 28px);box-sizing:border-box;padding:10px;border-radius:12px;pointer-events:auto;
  background:rgba(18,18,18,.94);box-shadow:0 0 0 1px #ffffff26,0 18px 50px rgba(0,0,0,.55);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}
.cn-pick h4{margin:0 2px 8px;font-size:12px;font-weight:700;letter-spacing:.04em;color:#a8a8a8}
.cn-chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.cn-chips button{font:inherit;font-weight:700;font-size:12px;color:var(--paper);border:0;border-radius:999px;padding:5px 11px;background:rgba(255,255,255,.09);cursor:pointer}
.cn-chips button:hover:not(:disabled){background:var(--accent);color:#141414}
.cn-chips button:disabled,.cn-list button:disabled{opacity:.35;cursor:default}
.cn-find{display:block;box-sizing:border-box;width:100%;margin-bottom:4px;padding:7px 10px;border:0;border-radius:8px;background:rgba(255,255,255,.07);
  font:inherit;font-size:12px;color:var(--paper);outline:none}
.cn-find::placeholder{color:#7a7a7a}
.cn-list{max-height:216px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
.cn-list button{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:7px;background:none;
  font:inherit;font-size:12px;color:var(--paper);text-align:left;cursor:pointer;font-variant-numeric:tabular-nums}
.cn-list button:hover:not(:disabled){background:rgba(255,255,255,.08)}
.cn-list .r{color:#7a7a7a;font-weight:700}
.cn-list .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}
.cn-list .t{color:#a8a8a8}
.cn-none{display:block;padding:10px 8px;color:#7a7a7a}
.cn-error{margin:6px 2px 0;color:var(--bad)}
.cn-tag{position:absolute;left:0;top:0;padding:2px 7px;border-radius:6px;background:rgba(14,14,14,.7);color:var(--run);font-size:11.5px;font-weight:700;
  white-space:nowrap;will-change:transform;box-shadow:inset 0 -2px 0 var(--run);pointer-events:auto;cursor:pointer}
.cn-tag.on{background:var(--run);color:#141414}
.cn-hint{position:absolute;left:50%;top:18px;transform:translateX(-50%);margin:0;padding:5px 11px;border-radius:8px;background:rgba(14,14,14,.66);
  color:#cfcfcf;white-space:nowrap;transition:opacity .6s;opacity:0}
.cn-hint.on{opacity:1}
@media(max-width:760px){.cn-row{max-width:calc(100vw - 28px)}.cn-run .t{display:none}}
`;

// This run's distance from another at this point: gap is the other run's
// time to here minus this one's, so positive means this run is behind.
export function gapText(gap) {
  if (!Number.isFinite(gap)) return {value: '', tone: '', title: ''};
  const behind = -gap;
  if (Math.abs(behind) < 0.0005) return {value: '±0.000', tone: '', title: 'Level here'};
  return {value: `${behind > 0 ? '+' : '−'}${Math.abs(behind).toFixed(3)}`, tone: behind > 0 ? 'loss' : 'good',
    title: `This run is ${Math.abs(behind).toFixed(3)} s ${behind > 0 ? 'behind' : 'ahead'} here`};
}

// getSources() gives the inputs of ghostSources (best, recentBest, refs, canWatch, archive) for the loaded map.
export function createCinemaUi({root, cinema, getSources = () => ({}), storage = null}) {
  const section = root.getElementById('cinema');
  const row = section.querySelector('.cn-row'), runs = section.querySelector('.cn-runs'), add = section.querySelector('[data-cn="add"]');
  const seg = section.querySelector('.cn-seg'), reset = section.querySelector('[data-cn="reset"]'), pick = section.querySelector('.cn-pick');
  const tagLayer = section.querySelector('.cn-tags'), hint = section.querySelector('.cn-hint');
  let frame = 0, shown = false, drawn = '', hintTimer = 0, named = true, picking = false, filter = '', error = '', tags = [], hinted = false;
  let anchor = null, custom = false;
  const write = (element, text) => { if (element.textContent !== text) element.textContent = text; };

  function choices() {
    let input = {};
    try { input = getSources() ?? {}; } catch { /* none */ }
    const fixed = ghostSources(input), refs = input.refs ?? null;
    const entries = Array.isArray(refs?.entries) ? refs.entries.filter(entry => entry?.runId && Number.isSafeInteger(entry.rank)).map(entry => boardSource(entry, refs)) : [];
    return {fixed, entries};
  }
  function taken() {
    const status = cinema.status();
    return new Set([...(status?.runs ?? []).map(run => run.id), ...(status?.loading ?? []).map(run => run.id)]);
  }
  function paintPicker() {
    const {fixed, entries} = choices(), used = taken(), full = used.size >= MAX_GHOSTS;
    const needle = filter.trim().toLowerCase().replace(/^#/, '');
    const listed = entries.filter(entry => !needle || entry.label.toLowerCase().replace(/^#/, '').includes(needle));
    const why = source => used.has(source.id) ? 'Already in this replay' : full ? `Up to ${MAX_GHOSTS} runs alongside this one` : source.reason ?? '';
    pick.innerHTML = `<h4>Add a run</h4>
      <div class="cn-chips">${fixed.map(source => `<button type="button" data-run="${escape(source.id)}"${source.load && !why(source) ? '' : ' disabled'} title="${escape(why(source) || (Number.isFinite(source.time) ? `${source.label} · ${formatTime(source.time)}` : source.label))}">${escape(source.label)}</button>`).join('')}</div>
      ${entries.length ? `<input class="cn-find" type="search" placeholder="Find a name or rank" aria-label="Find a run on the leaderboard" value="${escape(filter)}" autocomplete="off" spellcheck="false">
      <div class="cn-list" role="listbox" aria-label="Leaderboard">${listed.length ? listed.map(source => `<button type="button" role="option" data-run="${escape(source.id)}"${why(source) ? ` disabled title="${escape(why(source))}"` : ''}>
        <span class="r">${escape(source.label.split(' ')[0])}</span><span class="n">${escape(source.label.slice(source.label.indexOf(' ') + 1))}</span><span class="t">${escape(formatTime(source.time))}</span></button>`).join('') : '<span class="cn-none">No one by that name</span>'}</div>` : ''}
      ${error ? `<p class="cn-error" role="alert">${escape(error)}</p>` : ''}`;
  }
  // The picker's key and outside-click listeners exist only while it's open.
  function openPicker(open) {
    if (picking !== open) {
      for (const type of ['keydown', 'keyup']) (open ? addEventListener : removeEventListener)(type, keys, true);
      (open ? addEventListener : removeEventListener)('pointerdown', outside, true);
    }
    picking = open;
    pick.hidden = !open;
    add.setAttribute('aria-expanded', String(open));
    if (!open) { filter = ''; error = ''; return; }
    paintPicker();
    place();
    pick.querySelector('.cn-find')?.focus({preventScroll: true});
  }
  function choose(id) {
    const {fixed, entries} = choices(), source = [...fixed, ...entries].find(item => item.id === id);
    if (!source?.load) return;
    openPicker(false);
    cinema.add({id: source.id, label: source.label, load: source.load}).catch(failure => {
      error = failure?.message || 'That run couldn’t be added.';
      openPicker(true);
    });
  }

  section.addEventListener('click', event => {
    const button = event.target.closest('button');
    // A run's chip or name puts the camera on that run; again, back on everyone.
    const runFocus = !button && event.target.closest('[data-focus]');
    if (runFocus) { void cinema.setFocus(runFocus.dataset.focus); return; }
    if (!button || button.disabled) return;
    if (button.dataset.cn === 'add') openPicker(!picking);
    else if (button.dataset.cn === 'reset') cinema.resetView();
    else if (button.dataset.remove) cinema.remove(button.dataset.remove);
    else if (button.dataset.sync) void cinema.setSync(button.dataset.sync);
    else if (button.dataset.run) choose(button.dataset.run);
  });
  section.addEventListener('keydown', event => {
    const runFocus = (event.key === 'Enter' || event.key === ' ') && event.target.closest?.('[data-focus]');
    if (runFocus) { event.preventDefault(); event.stopPropagation(); void cinema.setFocus(runFocus.dataset.focus); }
  });
  section.addEventListener('input', event => {
    if (!event.target.matches?.('.cn-find')) return;
    filter = event.target.value.slice(0, 40);
    const caret = event.target.selectionEnd;
    paintPicker();
    const find = pick.querySelector('.cn-find');
    find?.focus({preventScroll: true});
    find?.setSelectionRange?.(caret, caret);
  });
  // Typing in the picker is the picker's, not the game's; Escape closes it.
  const keys = event => {
    if (!picking || !event.composedPath().includes(pick)) return;
    if (event.type === 'keydown' && event.key === 'Escape') { event.preventDefault(); openPicker(false); add.focus(); }
    event.stopPropagation();
  };
  const outside = event => { if (picking && !event.composedPath().some(node => node === pick || node === add)) openPicker(false); };

  // Names and gaps follow the ghosts every frame, and only while ghosts play.
  function follow() {
    frame = 0;
    const status = shown ? cinema.status() : null;
    if (!status?.active) return;
    const spots = tags.map((_, index) => named ? status.labels?.[index] ?? null : null);
    // Ghosts side by side would put one name over another: lift each clear of those below it.
    const order = spots.map((spot, index) => ({spot, index})).filter(item => item.spot).sort((a, b) => b.spot.y - a.spot.y);
    for (let i = 1; i < order.length; i++) {
      for (let j = 0; j < i; j++) {
        const lower = order[j], item = order[i];
        if (Math.abs(item.spot.x - lower.spot.x) < (tags[item.index].offsetWidth + tags[lower.index].offsetWidth) / 2 + 6 && Math.abs(item.spot.y - lower.spot.y) < 24)
          item.spot = spots[item.index] = {x: item.spot.x, y: lower.spot.y - 24};
      }
    }
    for (const [index, tag] of tags.entries()) {
      const at = spots[index];
      if (tag.hidden !== !at) tag.hidden = !at;
      if (at) tag.style.transform = `translate(${at.x.toFixed(1)}px,${(at.y - 6).toFixed(1)}px) translate(-50%,-100%)`;
    }
    for (const [index, run] of status.runs.entries()) {
      const cell = runs.querySelector(`[data-ghost="${index}"] .g`);
      if (!cell) continue;
      const gap = gapText(run.gap);
      write(cell, gap.value);
      const tone = `g${gap.tone ? ` ${gap.tone}` : ''}`;
      if (cell.className !== tone) cell.className = tone;
      if (cell.title !== gap.title) cell.title = gap.title;
    }
    frame = requestAnimationFrame(follow);
  }
  function paintRow(status) {
    const key = JSON.stringify([status?.active, status?.runs.map(run => [run.id, run.label, run.color, run.time]), status?.loading.map(run => run.id),
      status?.played.time, status?.sync, status?.focus, status?.pending, status?.adjusted]);
    if (key === drawn) return;
    drawn = key;
    const focus = (id, label) => ` data-focus="${escape(id)}" role="button" tabindex="0" aria-pressed="${status?.focus === id}" title="${status?.focus === id ? 'Back to everyone' : `Follow ${escape(label)}`}"`;
    const on = id => status?.focus === id ? ' on' : '';
    const played = status?.active ? `<span class="cn-run played${on('played')}" style="--run:${colorOf(0)}"${focus('played', 'this run')}><i aria-hidden="true"></i><b>This run</b><span class="t">${escape(Number.isFinite(status.played.time) ? formatTime(status.played.time) : '')}</span></span>` : '';
    runs.innerHTML = played + (status?.runs ?? []).map((run, index) => `<span class="cn-run${on(run.id)}" data-ghost="${index}" style="--run:${run.color}"${focus(run.id, run.label)}><i aria-hidden="true"></i><b>${escape(run.label)}</b><span class="t">${escape(Number.isFinite(run.time) ? formatTime(run.time) : '')}</span><span class="g"></span><button type="button" class="cn-x" data-remove="${escape(run.id)}" aria-label="Remove ${escape(run.label)}" title="Remove from this replay">${CLOSE}</button></span>`).join('') +
      (status?.loading ?? []).map((run, index) => `<span class="cn-run loading" style="--run:${colorOf(status.runs.length + index + 1)}"><i aria-hidden="true"></i>${escape(run.label)}…</span>`).join('');
    const ghosts = !!status?.active;
    seg.hidden = !ghosts;
    for (const button of seg.querySelectorAll('[data-sync]')) {
      button.setAttribute('aria-checked', String(status?.sync === button.dataset.sync));
      button.toggleAttribute('aria-busy', status?.pending === button.dataset.sync);
    }
    reset.hidden = !status?.adjusted;
    add.disabled = (status?.runs.length ?? 0) + (status?.loading.length ?? 0) >= MAX_GHOSTS;
    const labels = ghosts ? [['played', 'This run'], ...status.runs.map(run => [run.id, run.label])] : [];
    tagLayer.innerHTML = labels.map(([id, label], index) => `<span class="cn-tag${on(id)}" style="--run:${colorOf(index)}" data-focus="${escape(id)}" title="${status.focus === id ? 'Back to everyone' : `Follow ${escape(label)}`}" hidden>${escape(label)}</span>`).join('');
    tags = [...tagLayer.children];
    if (picking) paintPicker();
  }
  function place() {
    if (!anchor) return;
    const left = custom ? anchor.left + 14 : anchor.left, bottom = custom ? innerHeight - anchor.top + 8 : innerHeight - anchor.bottom + 25;
    row.style.left = `${Math.round(left)}px`; row.style.bottom = `${Math.round(bottom)}px`;
    pick.style.left = `${Math.round(Math.max(14, Math.min(add.getBoundingClientRect().left, innerWidth - pick.offsetWidth - 14)))}px`;
    pick.style.bottom = `${Math.round(bottom + row.offsetHeight + 8)}px`;
  }
  function showHint() {
    let seen = false;
    try { seen = storage?.getItem(HINT_KEY) === '1'; } catch { /* shown again */ }
    if (seen) return;
    hint.classList.add('on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.classList.remove('on'); try { storage?.setItem(HINT_KEY, '1'); } catch { /* shown again */ } }, HINT_MS);
  }
  function hide() {
    if (!shown) return;
    shown = false;
    section.hidden = true;
    openPicker(false);
    cancelAnimationFrame(frame); frame = 0;
    clearTimeout(hintTimer); hint.classList.remove('on');
    drawn = ''; tags = []; tagLayer.innerHTML = '';
  }

  return {
    // track: the replay bar's timeline rect (custom: the custom bar's rect);
    // idle: the bar has faded out; tags: whether names may show (not over the finish card).
    render({visible, track = null, custom: customBar = false, idle = false, tags: showTags = true}) {
      const status = cinema.status();
      if (!visible || !track || !status && !cinema.available()) { hide(); return; }
      if (!shown) { shown = true; section.hidden = false; }
      anchor = track; custom = customBar;
      paintRow(status);
      place();
      row.classList.toggle('idle', idle && !picking);
      named = showTags;
      if (status?.active) {
        if (!hinted) { hinted = true; showHint(); }
        if (!frame) frame = requestAnimationFrame(follow);
      }
    },
    hide,
    get shown() { return shown; },
    destroy() { hide(); },
  };
}
