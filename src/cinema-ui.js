// Cinematic actions and added runs share the replay's existing control row;
// names follow the runners without repainting the controls.
import {formatTime} from './hud-model.js';
import {boardSource, ghostSources} from './ghost-sources.js';
import {colorOf} from './cinema.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';
const CARET = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5"/></svg>';
const HINT_KEY = 'surfd-qol.ghost-hint';
const HINT_MS = 5000;
// The camera style last chosen, which adding a run switches to.
const STYLE_KEY = 'surfd-qol.camera-style';
const VIEWS = [['pov', 'POV', 'The player’s own view'], ['steady', 'Steady', 'A calm camera behind the runs'], ['cinematic', 'Cinematic', 'Varied shots from around the route']];

export const cinemaMarkup = `<section id="cinema" class="cn" aria-label="Ghosts" hidden>
  <div class="cn-tags"></div>
  <div class="cn-strip" role="group" aria-label="Runs in this replay" hidden><div class="cn-runs"></div></div>
  <div class="cn-row" role="group" aria-label="Cinematic controls" hidden>
    <button type="button" class="cn-btn cn-add" data-cn="add" aria-haspopup="dialog" aria-expanded="false" title="Play another run of this map alongside this one">${PLUS}Add run</button>
    <button type="button" class="cn-btn cn-view" data-cn="view" aria-haspopup="menu" aria-expanded="false" title="How to watch: first person or a camera"><span>POV</span>${CARET}</button>
    <div class="cn-seg" role="group" aria-label="Match runs" hidden>
      <button type="button" data-sync="time" aria-pressed="false" title="Runs on the clock, as a race">Real time</button>
      <button type="button" data-sync="place" aria-pressed="false" title="Runs at the same place on the route: the faster one is slowed down">Side by side</button>
    </div>
    <button type="button" class="cn-btn" data-cn="reset" title="Back to the planned camera (or double-click the view)" hidden>Reset view</button>
  </div>
  <div class="cn-pick" role="dialog" aria-label="Add a run" hidden></div>
  <div class="cn-views" role="menu" aria-label="View" hidden>${VIEWS.map(([view, name, about]) =>
    `<button type="button" role="menuitemradio" data-view="${view}" aria-checked="false"><b>${name}</b><span>${about}</span></button>`).join('')}</div>
  <p class="cn-hint">Drag to look around · Scroll to zoom · Double-click to reset</p>
</section>`;

export const cinemaStyles = `
.cn{position:fixed;inset:0;pointer-events:none;color:var(--paper);font-size:12px;z-index:1}
.cn-row{display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0;pointer-events:auto;-webkit-text-stroke:0;text-shadow:none}
.cn-strip{min-width:0;overflow:hidden;pointer-events:auto}
.cn-runs{display:flex;align-items:center;gap:5px;min-width:0;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:thin;scrollbar-color:#ffffff30 transparent;padding:2px}
.cn-btn,.cn-run,.cn-seg{font-family:inherit;font-weight:700;font-size:12px;line-height:1.2;color:var(--paper);border:1px solid #ffffff30;border-radius:8px;background:rgba(18,18,18,.88);white-space:nowrap}
.cn-row .cn-btn{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:4px 8px;cursor:pointer}
.cn-btn:hover,.cn-btn[aria-expanded=true]{border-color:var(--accent)}
.cn-btn[aria-pressed=true],.cn-view.on{border-color:var(--accent);color:var(--accent)}
.rb-tools .cn-row{order:-1}
.rb .cn-row{flex-wrap:nowrap;gap:2px;-webkit-text-stroke:inherit;text-shadow:inherit}
.rb .cn-row .cn-btn,.rb .cn-row .cn-seg button{height:34px;min-height:34px;padding:0 7px;border:0;border-radius:10px;background:transparent;font:inherit;font-weight:700;line-height:1.2;color:inherit}
.rb .cn-row .cn-btn{display:inline-flex}
.rb .cn-row .cn-btn:hover,.rb .cn-row .cn-btn[aria-expanded=true],.rb .cn-row .cn-seg button:hover{background:rgba(255,255,255,.14)}
.rb .cn-row .cn-btn[aria-pressed=true],.rb .cn-row .cn-view.on,.rb .cn-row .cn-seg button[aria-pressed=true]{color:var(--accent);background:rgba(255,255,255,.08)}
.rb .cn-seg{padding:0;gap:0;border:0;background:transparent}
.rb>.cn-strip{position:static;grid-column:3;grid-row:1;min-width:0;overflow:hidden;transition:opacity .35s}
.rb .cn-run{background:transparent;border-color:#ffffff24;-webkit-text-stroke:0;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.rb .cn-run.on{background:color-mix(in srgb,var(--run) 10%,transparent);border-color:var(--run)}
.rb.rest>.cn-strip{opacity:0;pointer-events:none}
.cn-btn:disabled{opacity:.45;cursor:default;border-color:#ffffff30}
.cn-btn svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.cn-view svg{width:11px;height:11px;margin-right:-2px;opacity:.7;stroke-linejoin:round}
.cn-view[aria-busy=true]{opacity:.6}
.cn-views{position:absolute;display:grid;gap:2px;width:228px;max-width:calc(100vw - 28px);box-sizing:border-box;padding:5px;border-radius:12px;pointer-events:auto;
  background:rgba(18,18,18,.94);box-shadow:0 0 0 1px #ffffff26,0 18px 50px rgba(0,0,0,.55);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}
.cn-views button{display:grid;gap:1px;padding:7px 10px;border:0;border-radius:8px;background:none;font:inherit;font-size:12px;color:var(--paper);text-align:left;cursor:pointer}
.cn-views button:hover,.cn-views button:focus-visible{background:rgba(255,255,255,.08)}
.cn-views button[aria-checked=true] b{color:var(--accent)}
.cn-views span{color:#a8a8a8;font-size:11.5px}
.cn-run{display:inline-flex;align-items:center;gap:4px;flex:none;min-width:0;padding:0 3px 0 0;font-variant-numeric:tabular-nums}
.cn-run.played{padding-right:3px}
.cn-focus{display:inline-flex;align-items:center;gap:7px;min-width:0;padding:5px 7px;border:0;background:none;color:inherit;font:inherit;cursor:pointer}
.cn-focus:hover{background:#ffffff0a}
.cn-run.on{border-color:var(--run);background:color-mix(in srgb,var(--run) 16%,rgba(18,18,18,.9))}
.cn-run i{flex:none;width:4px;height:14px;border-radius:1.5px;transform:skewX(-18deg);background:var(--run)}
.cn-run b{max-width:16ch;overflow:hidden;text-overflow:ellipsis}
.cn-run .t{color:#a8a8a8;font-weight:400}
.cn-run .g{min-width:5.2ch;text-align:right}
.cn-run .g:empty{display:none}
.cn-run .g.good{color:var(--good)}.cn-run .g.loss{color:var(--bad)}
.cn-run.loading{color:#a8a8a8;padding:5px 9px}
.cn-run.loading i{animation:cn-pulse 1s ease-in-out infinite alternate}
@keyframes cn-pulse{to{opacity:.3}}
.cn-x{display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:none;color:#8a8a8a;cursor:pointer}
.cn-x:hover{background:rgba(255,255,255,.1);color:var(--paper)}
.cn-x svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
.cn-seg{display:flex;padding:2px;gap:2px}
.cn [hidden],.cn-row[hidden],.cn-row [hidden],.cn-strip[hidden]{display:none}
.cn-row .cn-seg button{font:inherit;color:#a8a8a8;border:0;border-radius:6px;min-height:22px;padding:3px 7px;background:none;cursor:pointer}
.cn-row .cn-seg button:hover{color:var(--paper)}
.cn-row .cn-seg button[aria-pressed=true]{background:rgba(255,255,255,.14);color:var(--paper)}
.cn-seg button[aria-busy=true]{opacity:.6}
.cn :focus-visible,.cn-row :focus-visible,.cn-strip :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cn-views :focus-visible{outline-offset:-2px}
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
.cn-tag{position:absolute;left:0;top:0;padding:2px 7px;border:0;border-radius:6px;background:rgba(14,14,14,.7);color:var(--run);font-family:inherit;font-size:11.5px;font-weight:700;
  white-space:nowrap;will-change:transform;box-shadow:inset 0 -2px 0 var(--run);pointer-events:auto;cursor:pointer}
.cn-tag.on{background:var(--run);color:#141414}
.cn-hint{position:absolute;left:50%;top:18px;transform:translateX(-50%);margin:0;padding:5px 11px;border-radius:8px;background:rgba(14,14,14,.66);
  color:#cfcfcf;white-space:nowrap;transition:opacity .6s;opacity:0}
.cn-hint.on{opacity:1}
@media(max-width:760px){.cn-run .t{display:none}.cn-row{gap:3px}.cn-row .cn-btn{padding-inline:6px}}
@media(prefers-reduced-motion:reduce){.cn-strip,.cn-hint{transition:none}.cn-run.loading i{animation:none}}
`;

// The added run's time to this place minus the watched run's time.
export function gapText(gap) {
  if (!Number.isFinite(gap)) return {value: '', tone: '', title: ''};
  if (Math.abs(gap) < 0.0005) return {value: '±0.000', tone: '', title: 'Level here'};
  return {value: `${gap > 0 ? '+' : '−'}${Math.abs(gap).toFixed(3)}`, tone: gap > 0 ? 'loss' : 'good',
    title: `${Math.abs(gap).toFixed(3)} s ${gap > 0 ? 'behind' : 'ahead of'} the watched run here`};
}

// getSources() gives the inputs of ghostSources (best, recentBest, refs, canWatch, archive) for the loaded map.
export function createCinemaUi({root, cinema, getSources = () => ({}), storage = null}) {
  const section = root.getElementById('cinema');
  const row = section.querySelector('.cn-row'), strip = section.querySelector('.cn-strip'), runs = section.querySelector('.cn-runs');
  const add = row.querySelector('[data-cn="add"]'), viewButton = row.querySelector('[data-cn="view"]');
  const seg = row.querySelector('.cn-seg'), reset = row.querySelector('[data-cn="reset"]'), pick = section.querySelector('.cn-pick');
  const menu = section.querySelector('.cn-views'), items = [...(menu?.querySelectorAll('[data-view]') ?? [])];
  const tagLayer = section.querySelector('.cn-tags'), hint = section.querySelector('.cn-hint');
  let frame = 0, shown = false, drawn = '', hintTimer = 0, named = true, picking = false, choosing = false, filter = '', error = '', tags = [], hinted = false;
  let toolbar = null, layout = null, gapCells = [], widths = [], escapeHeld = false, controls = '';
  const hovered = new Set();
  const write = (element, text) => { if (element.textContent !== text) element.textContent = text; };
  const attr = (element, name, value) => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };
  const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
  try { const style = storage?.getItem(STYLE_KEY); if (style) void cinema.setStyle?.(style); } catch { /* the default */ }

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
  function paintPicker(listOnly = false) {
    const {fixed, entries} = choices(), used = taken();
    const needle = filter.trim().toLowerCase().replace(/^#/, '');
    const listed = entries.filter(entry => !needle || entry.label.toLowerCase().replace(/^#/, '').includes(needle));
    const why = source => used.has(source.id) ? 'Already in this replay' : source.reason ?? '';
    const list = listed.length ? listed.map(source => `<button type="button" data-run="${escape(source.id)}"${why(source) ? ` disabled title="${escape(why(source))}"` : ''}>
      <span class="r">${escape(source.label.split(' ')[0])}</span><span class="n">${escape(source.label.slice(source.label.indexOf(' ') + 1))}</span><span class="t">${escape(formatTime(source.time))}</span></button>`).join('') : '<span class="cn-none">No one by that name</span>';
    if (listOnly) { const target = pick.querySelector('.cn-list'); if (target) target.innerHTML = list; return; }
    const focused = root.activeElement, searching = focused?.matches?.('.cn-find'), caret = searching ? focused.selectionEnd : null;
    const focusedRun = pick.contains(focused) ? focused?.dataset.run : null;
    pick.innerHTML = `<h4>Add a run</h4>
      <div class="cn-chips">${fixed.map(source => `<button type="button" data-run="${escape(source.id)}"${source.load && !why(source) ? '' : ' disabled'} title="${escape(why(source) || (Number.isFinite(source.time) ? `${source.label} · ${formatTime(source.time)}` : source.label))}">${escape(source.label)}</button>`).join('')}</div>
      ${entries.length ? `<input class="cn-find" type="search" maxlength="40" placeholder="Find a name or rank" aria-label="Find a run on the leaderboard" value="${escape(filter)}" autocomplete="off" spellcheck="false"><div class="cn-list" role="group" aria-label="Leaderboard">${list}</div>` : ''}
      ${error ? `<p class="cn-error" role="alert">${escape(error)}</p>` : ''}`;
    if (searching) {
      const find = pick.querySelector('.cn-find');
      find?.focus({preventScroll: true});
      find?.setSelectionRange?.(caret, caret);
    } else if (focusedRun) {
      (pick.querySelector(`[data-run="${CSS.escape(focusedRun)}"]:not(:disabled)`) ?? pick.querySelector('.cn-find') ?? add).focus({preventScroll: true});
    }
  }
  // Outside clicks are observed only while the picker is open.
  function openPicker(open) {
    if (open && choosing) openMenu(false);
    if (picking !== open && !choosing) (open ? addEventListener : removeEventListener)('pointerdown', outside, true);
    picking = open;
    pick.hidden = !open;
    add.setAttribute('aria-expanded', String(open));
    if (!open) { filter = ''; error = ''; return; }
    paintPicker();
    place();
    (pick.querySelector('.cn-find') ?? pick.querySelector('button:not(:disabled)'))?.focus({preventScroll: true});
  }
  // The view menu: first person or a camera style. Outside clicks close it as they do the picker.
  function openMenu(open, focusItem = open) {
    if (!menu) return;
    if (open) openPicker(false);
    if (choosing !== open && !picking) (open ? addEventListener : removeEventListener)('pointerdown', outside, true);
    choosing = open;
    menu.hidden = !open;
    viewButton.setAttribute('aria-expanded', String(open));
    if (!open) return;
    place();
    if (focusItem) (items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus({preventScroll: true});
  }
  function chooseView(view) {
    openMenu(false);
    viewButton.focus({preventScroll: true});
    if (view !== 'pov') { try { storage?.setItem(STYLE_KEY, view); } catch { /* not remembered */ } }
    viewButton.setAttribute('aria-busy', 'true');
    void perform(() => cinema.setView(view)).finally(() => viewButton.removeAttribute('aria-busy'));
  }
  async function perform(action) {
    try { return await action(); }
    catch (failure) {
      if (!shown) return;
      error = failure?.message || 'The cinematic view couldn’t be updated.';
      openPicker(true);
    }
  }
  function choose(id) {
    const {fixed, entries} = choices(), source = [...fixed, ...entries].find(item => item.id === id);
    if (!source?.load) return;
    openPicker(false);
    add.focus({preventScroll: true});
    void perform(() => cinema.add({id: source.id, label: source.label, load: source.load}));
  }

  const click = event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.cn === 'add') openPicker(!picking);
    else if (button.dataset.cn === 'view') openMenu(!choosing, false);
    else if (button.dataset.view) chooseView(button.dataset.view);
    else if (button.dataset.cn === 'reset') cinema.resetView();
    else if (button.dataset.remove) { void perform(() => cinema.remove(button.dataset.remove)); add.focus({preventScroll: true}); }
    else if (button.dataset.focus) void perform(() => cinema.setFocus(button.dataset.focus));
    else if (button.dataset.sync) void perform(() => cinema.setSync(button.dataset.sync));
    else if (button.dataset.run) choose(button.dataset.run);
  };
  section.addEventListener('click', click);
  row.addEventListener('click', event => { if (row.parentElement !== section) click(event); });
  strip.addEventListener('click', event => { if (strip.parentElement !== section) click(event); });
  strip.addEventListener('wheel', event => {
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY) || runs.scrollWidth <= runs.clientWidth) return;
    event.preventDefault();
    runs.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? runs.clientWidth : 1);
  }, {passive: false});
  for (const element of [row, strip, pick, menu].filter(Boolean)) {
    element.addEventListener('pointerenter', () => hovered.add(element));
    element.addEventListener('pointerleave', () => hovered.delete(element));
  }
  section.addEventListener('input', event => {
    if (!event.target.matches?.('.cn-find')) return;
    filter = event.target.value.slice(0, 40);
    paintPicker(true);
  });
  // Called before replay/game shortcuts. Native buttons retain their normal
  // Enter/Space activation; those keys must not also pause the replay.
  function handleKey(event) {
    const path = event.composedPath();
    if (event.key === 'Escape' && (picking || choosing || escapeHeld)) {
      event.preventDefault(); event.stopImmediatePropagation();
      escapeHeld = event.type === 'keydown';
      if (escapeHeld) {
        const opener = choosing ? viewButton : add;
        openPicker(false); openMenu(false);
        opener.focus({preventScroll: true});
      }
      return true;
    }
    // The menu moves with the arrow keys, from its button too; Tab leaves it.
    if (menu && (path.includes(menu) || path.includes(viewButton)) && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) {
      if (event.key === 'Tab') { if (choosing && event.type === 'keydown') openMenu(false); return false; }
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type !== 'keydown') return true;
      if (!choosing) { openMenu(true); return true; }
      const at = items.indexOf(root.activeElement), last = items.length - 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next].focus({preventScroll: true});
      return true;
    }
    if (menu && path.includes(menu) && (event.key === ' ' || event.key === 'Enter')) { event.stopImmediatePropagation(); return true; }
    if (path.includes(pick) || (event.key === ' ' || event.key === 'Enter') && path.some(node => node?.matches?.('.cn-row button,.cn-focus,.cn-x,.cn-tag'))) {
      event.stopImmediatePropagation();
      return true;
    }
  }
  const outside = event => {
    const path = event.composedPath();
    if (picking && !path.some(node => node === pick || node === add)) openPicker(false);
    if (choosing && !path.some(node => node === menu || node === viewButton)) openMenu(false);
  };

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
        if (Math.abs(item.spot.x - lower.spot.x) < (widths[item.index] + widths[lower.index]) / 2 + 6 && Math.abs(item.spot.y - lower.spot.y) < 24)
          item.spot = spots[item.index] = {x: item.spot.x, y: lower.spot.y - 24};
      }
    }
    for (const [index, tag] of tags.entries()) {
      const at = spots[index];
      if (tag.hidden !== !at) tag.hidden = !at;
      if (at) tag.style.transform = `translate(${at.x.toFixed(1)}px,${(at.y - 6).toFixed(1)}px) translate(-50%,-100%)`;
    }
    for (const [index, run] of status.runs.entries()) {
      const cell = gapCells[index];
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
    const active = !!status?.active, extras = status?.runs ?? [], loading = status?.loading ?? [];
    const key = JSON.stringify([active, status?.played, extras.map(run => [run.id, run.label, run.color, run.time]), loading.map(run => [run.id, run.label, run.color])]);
    const changed = key !== drawn;
    if (changed) {
      drawn = key;
      const labels = active ? [{id: 'played', label: status.played?.label || 'This run', time: status.played?.time, color: status.played?.color ?? colorOf(0)}, ...extras] : [];
      const focus = run => `data-focus="${escape(run.id)}" aria-pressed="false" title="Follow ${escape(run.label)}"`;
      const chip = run => `<span class="cn-run" style="--run:${run.color}"><button type="button" class="cn-focus" ${focus(run)}><i aria-hidden="true"></i><b>${escape(run.label)}</b><span class="t">${Number.isFinite(run.time) ? formatTime(run.time) : ''}</span>${run.id === 'played' ? '' : '<span class="g"></span>'}</button>${run.id === 'played' ? '' : `<button type="button" class="cn-x" data-remove="${escape(run.id)}" aria-label="Remove ${escape(run.label)}" title="Remove from this replay">${CLOSE}</button>`}</span>`;
      const focused = root.activeElement?.dataset;
      runs.innerHTML = extras.length || loading.length ? labels.map(chip).join('') + loading.map(run => `<span class="cn-run loading" style="--run:${run.color ?? colorOf(run.colorIndex)}"><i aria-hidden="true"></i>${escape(run.label)}…</span>`).join('') : '';
      gapCells = [...runs.querySelectorAll('.g')];
      tagLayer.innerHTML = labels.map(run => `<button type="button" class="cn-tag" style="--run:${run.color}" ${focus(run)} hidden>${escape(run.label)}</button>`).join('');
      tags = [...tagLayer.children];
      // Label widths only change with the text: measure once, since offsetWidth forces layout.
      for (const tag of tags) { tag.hidden = false; tag.style.visibility = 'hidden'; }
      widths = tags.map(tag => tag.offsetWidth);
      for (const tag of tags) { tag.hidden = true; tag.style.visibility = ''; }
      if (focused?.focus || focused?.remove) {
        const selector = focused.remove ? `[data-remove="${CSS.escape(focused.remove)}"]` : `.cn-focus[data-focus="${CSS.escape(focused.focus)}"]`;
        (runs.querySelector(selector) ?? add).focus({preventScroll: true});
      }
      if (picking) paintPicker();
    }
    const view = status?.view ?? 'pov';
    const controlKey = JSON.stringify([active, view, status?.sync, status?.focus, status?.pending, status?.adjusted, extras.length, loading.length]);
    if (!changed && controlKey === controls) return false;
    controls = controlKey;
    const [, name] = VIEWS.find(([id]) => id === view) ?? VIEWS[0];
    const label = viewButton.querySelector?.('span');
    if (label) write(label, name);
    viewButton.classList.toggle('on', view !== 'pov');
    attr(viewButton, 'aria-label', `View: ${name}`);
    for (const item of items) attr(item, 'aria-checked', String(item.dataset.view === view));
    seg.hidden = !extras.length;
    for (const button of seg.querySelectorAll('[data-sync]')) {
      attr(button, 'aria-pressed', String(status?.sync === button.dataset.sync));
      const pending = status?.pending === button.dataset.sync;
      if (button.hasAttribute('aria-busy') !== pending) button.toggleAttribute('aria-busy', pending);
    }
    reset.hidden = !active || !status?.adjusted;
    for (const button of [...runs.querySelectorAll('[data-focus]'), ...tags]) {
      const on = status?.focus === button.dataset.focus;
      attr(button, 'aria-pressed', String(on));
      (button.closest('.cn-run') ?? button).classList.toggle('on', on);
      const label = button.dataset.focus === 'played' ? status.played?.label || 'this run' : extras.find(run => run.id === button.dataset.focus)?.label;
      button.title = on ? 'Back to group shot' : `Follow ${label}`;
    }
    return changed;
  }
  function place() {
    if (!shown || !layout || !picking && !choosing) return;
    const rect = layout.getBoundingClientRect(), toolsRect = toolbar.getBoundingClientRect();
    const bottom = Math.round(innerHeight - Math.min(rect.top, toolsRect.top) + 7);
    const popup = picking ? pick : menu, trigger = (picking ? add : viewButton).getBoundingClientRect();
    popup.style.left = `${Math.round(Math.max(14, Math.min(trigger.left, innerWidth - popup.offsetWidth - 14)))}px`;
    popup.style.maxHeight = `${Math.max(80, innerHeight - bottom - 22)}px`;
    popup.style.overflowY = 'auto';
    popup.style.bottom = `${bottom + 8}px`;
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
    section.hidden = row.hidden = strip.hidden = true;
    hovered.clear();
    openPicker(false);
    openMenu(false);
    cancelAnimationFrame(frame); frame = 0;
    clearTimeout(hintTimer); hint.classList.remove('on');
    drawn = controls = ''; tags = []; widths = []; gapCells = []; tagLayer.innerHTML = '';
    sizes?.disconnect();
    removeEventListener('resize', place);
    toolbar = layout = null;
  }

  return {
    // Both chip strips flow with their toolbar; only the picker needs geometry.
    render({visible, custom = false, tags: showTags = true, held = false}) {
      const status = cinema.status();
      if (!visible || !status && !cinema.available()) { hide(); return; }
      const target = root.querySelector(custom ? '.rb-tools' : '.nr-actions');
      const bar = custom ? root.getElementById('replay') : root.querySelector('.nr-tools');
      if (!target || !bar) { hide(); return; }
      if (!shown) { shown = true; section.hidden = row.hidden = false; addEventListener('resize', place, {passive: true}); }
      let moved = false;
      if (toolbar !== target) {
        toolbar = target; layout = bar; target.prepend(row);
        bar.prepend(strip);
        for (const button of row.querySelectorAll('button,select')) button.classList.toggle('rb-btn', custom);
        moved = true;
        sizes?.disconnect(); sizes?.observe(bar); sizes?.observe(target);
      }
      const changed = paintRow(status);
      strip.hidden = held || !(status?.runs.length || status?.loading.length);
      if (changed || moved) place();
      if (held && picking) openPicker(false);
      if (held && choosing) openMenu(false);
      named = showTags && !held;
      if (status?.active) {
        // Drag and zoom steer a camera only, so the hint waits for one.
        if (!hinted && status.view !== 'pov') { hinted = true; showHint(); }
        if (!frame) frame = requestAnimationFrame(follow);
      } else { cancelAnimationFrame(frame); frame = 0; }
    },
    hide,
    handleKey,
    get picking() { return picking; },
    get choosing() { return choosing; },
    get holding() { return shown && (picking || choosing || hovered.size > 0 || section.contains(root.activeElement) || row.contains(root.activeElement) || strip.contains(root.activeElement)); },
    get shown() { return shown; },
    destroy() { hide(); sizes?.disconnect(); row.remove(); strip.remove(); },
  };
}
