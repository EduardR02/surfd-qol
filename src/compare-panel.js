// The Runs panel's Compare view: pick two runs on the loaded map and watch
// them together. Your PB, recent best and both records are one click each;
// any other leaderboard run is in a short list you can filter by name.
import {formatTime} from './hud-model.js';
import {colorOf} from './cinema.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const ROLES = ['Play', 'Against'];

export const compareStyles = `
.cp{padding:6px 20px 14px}
.cp-slot{display:grid;grid-template-columns:76px minmax(0,1fr);align-items:center;gap:10px;padding:6px 0}
.cp-role{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;letter-spacing:.04em;color:var(--text-2)}
.cp-role i{flex:none;width:5px;height:15px;border-radius:1.5px;transform:skewX(-18deg);background:var(--run)}
.cp-slot .rn-seg{flex-wrap:wrap;justify-self:start;max-width:100%}
.cp-slot .rn-seg button{white-space:nowrap;max-width:190px;overflow:hidden;text-overflow:ellipsis}
.cp-slot .rn-seg button:disabled{opacity:.35;cursor:default}
.cp-slot .rn-seg button[aria-checked=true]{box-shadow:0 1px 2px rgba(0,0,0,.35),inset 0 -2px 0 var(--run)}
.cp-board{margin:2px 0 8px 86px;border-radius:11px;background:rgba(0,0,0,.3);box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.cp-find{display:block;box-sizing:border-box;width:100%;padding:8px 12px;border:0;border-bottom:1px solid var(--line);background:none;
  font:inherit;font-size:12.5px;color:var(--text);outline:none}
.cp-find::placeholder{color:var(--text-3)}
.cp-rows{max-height:186px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
.cp-rows button{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:8px;width:100%;padding:6px 12px;border:0;background:none;text-align:left;font-size:12.5px}
.cp-rows button:hover:not(:disabled){background:rgba(255,255,255,.07)}
.cp-rows button[aria-selected=true]{background:rgba(255,255,255,.11);box-shadow:inset 3px 0 0 var(--run)}
.cp-rows button:disabled{opacity:.35}
.cp-rows .cp-rank{color:var(--text-3);font-weight:700}
.cp-rows .cp-who{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-rows .cp-none{display:block;padding:10px 12px;font-size:12px;color:var(--text-3)}
.cp-go{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-top:10px}
.cp-go .rn-cta{display:inline-flex;align-items:center;margin:0}
.cp-go .rn-cta:disabled{opacity:.4}
.cp-go .rn-cta .rn-tri{color:var(--on-accent);opacity:1}
.cp-go .rn-cta[aria-busy=true] .rn-tri{clip-path:none;border-radius:50%;background:none;border:1.5px solid currentColor;border-right-color:transparent;animation:rn-spin .7s linear infinite}
.cp-sum{font-size:12.5px;color:var(--text-2)}
.cp-sum b{color:var(--text)}
.cp .rn-caption{margin:12px 0 0;font-weight:400}
@media(max-width:600px){.cp-slot{grid-template-columns:1fr;gap:6px}.cp-board{margin-left:0}}
`;

// The picks a slot offers on the loaded map, in order. Each is {id, label,
// short (for the view's legend), time, reason (why it can't be picked), load()}.
export function compareSources({best = null, recentBest = null, refs = null, canWatch = () => false, archive = null}) {
  const list = [];
  const local = run => run && canWatch(run) ? () => archive.get(run.id) : null;
  if (best?.official) list.push({id: 'pb', label: 'PB', short: 'Your PB', time: best.time, load: () => refs.loadReplay(best.runId)});
  else if (best) list.push({id: 'pb', label: 'Best finish', short: 'Your best', time: best.time, load: local(best),
    reason: local(best) ? '' : 'Its replay wasn’t kept'});
  else list.push({id: 'pb', label: 'PB', short: 'Your PB', time: null, load: null, reason: 'No finish on this map yet'});
  if (recentBest && recentBest.id !== best?.id) list.push({id: 'recent', label: 'Recent best', short: 'Recent best', time: recentBest.time,
    load: local(recentBest), reason: local(recentBest) ? '' : 'Its replay wasn’t kept'});
  const record = refs?.record;
  list.push(record?.runId && typeof refs.loadReplay === 'function'
    ? {id: 'wr', label: 'Site WR', short: `Site WR · ${record.username ?? '#1'}`, time: record.timeUs / 1e6, load: () => refs.loadReplay(record.runId)}
    : {id: 'wr', label: 'Site WR', short: 'Site WR', time: null, load: null, reason: 'No leaderboard on this map'});
  list.push(typeof refs?.loadRecordRoute === 'function'
    ? {id: 'ksf', label: 'KSF WR', short: 'KSF WR', time: null, load: () => refs.loadRecordRoute().then(replay => replay ?? Promise.reject(new Error('The KSF record route isn’t available.')))}
    : {id: 'ksf', label: 'KSF WR', short: 'KSF WR', time: null, load: null, reason: 'No KSF record route'});
  return list;
}
export function boardSource(entry, refs) {
  return {id: `run:${entry.runId}`, label: `#${entry.rank} ${entry.username ?? 'Guest'}`, short: `#${entry.rank} ${entry.username ?? 'Guest'}`,
    time: entry.timeUs / 1e6, load: () => refs.loadReplay(entry.runId)};
}

// "KSF WR is 2.418 s faster" for two picks with known times.
export function difference(first, second) {
  if (!Number.isFinite(first?.time) || !Number.isFinite(second?.time)) return '';
  const gap = Math.abs(first.time - second.time);
  if (gap < 0.0005) return 'Same time';
  const [faster] = first.time < second.time ? [first] : [second];
  return `<b>${escape(faster.short)}</b> is ${gap.toFixed(3)} s faster`;
}

export function createComparePicker({settings = {}, cinema = null, getReferences = () => null, archive = null, canWatch = () => false, onStarted = () => {}, onError = () => {}}) {
  // Picks are remembered while the page is open; leaderboard picks by run.
  const picks = ['pb', settings.wrSource === 'leaderboard' ? 'wr' : 'ksf'];
  let board = null, filter = '', starting = false, request = 0;

  function sources(view) {
    let refs = null;
    try { refs = getReferences(); } catch { /* none */ }
    const fixed = compareSources({best: view.best, recentBest: view.recentBest, refs, canWatch, archive});
    const entries = Array.isArray(refs?.entries) ? refs.entries.filter(entry => entry?.runId && Number.isSafeInteger(entry.rank)) : [];
    return {refs, fixed, entries};
  }
  function chosen(id, {refs, fixed, entries}) {
    if (id.startsWith('run:')) {
      const entry = entries.find(item => `run:${item.runId}` === id);
      return entry ? boardSource(entry, refs) : null;
    }
    return fixed.find(source => source.id === id) ?? null;
  }
  // A pick that is gone (a map change, a PB you no longer have) falls back to the first one available.
  function settle(list) {
    for (let slot = 0; slot < 2; slot++) {
      const pick = chosen(picks[slot], list);
      if (pick?.load) continue;
      const other = picks[1 - slot];
      const fallback = list.fixed.find(source => source.load && source.id !== other) ??
        list.entries.map(entry => boardSource(entry, list.refs)).find(source => source.id !== other);
      if (fallback) picks[slot] = fallback.id;
    }
  }

  function slot(index, list) {
    const pick = picks[index], isBoard = pick.startsWith('run:'), entry = isBoard ? chosen(pick, list) : null;
    const buttons = list.fixed.map(source => `<button type="button" role="radio" aria-checked="${pick === source.id}" tabindex="${pick === source.id ? 0 : -1}"
      data-compare-pick="${index}" data-id="${source.id}"${source.load ? '' : ' disabled'} title="${escape(source.reason || (Number.isFinite(source.time) ? `${source.label} · ${formatTime(source.time)}` : source.label))}">${escape(source.label)}</button>`);
    if (list.entries.length) buttons.push(`<button type="button" role="radio" aria-checked="${isBoard}" tabindex="${isBoard ? 0 : -1}" data-compare-board="${index}"
      aria-expanded="${board === index}" title="Any run on the leaderboard">${escape(entry ? entry.label : 'Leaderboard')}</button>`);
    return `<div class="cp-slot" style="--run:${colorOf(index)}"><span class="cp-role"><i aria-hidden="true"></i>${ROLES[index]}</span>
      <div class="rn-seg" role="radiogroup" aria-label="${ROLES[index]}">${buttons.join('')}</div></div>
      ${board === index ? rows(index, list) : ''}`;
  }
  function rows(index, list) {
    const needle = filter.trim().toLowerCase();
    const shown = list.entries.filter(entry => !needle || String(entry.username ?? '').toLowerCase().includes(needle) || String(entry.rank) === needle);
    return `<div class="cp-board" style="--run:${colorOf(index)}"><input class="cp-find" type="search" data-compare-find placeholder="Find a name or rank" aria-label="Find a run on the leaderboard" value="${escape(filter)}" autocomplete="off" spellcheck="false">
      <div class="cp-rows" role="listbox" aria-label="Leaderboard">${shown.length ? shown.map(entry => {
        const id = `run:${entry.runId}`;
        return `<button type="button" role="option" aria-selected="${picks[index] === id}" data-compare-pick="${index}" data-id="${escape(id)}"${picks[1 - index] === id ? ' disabled title="Already picked"' : ''}>
          <span class="cp-rank">#${entry.rank}</span><span class="cp-who">${escape(entry.username ?? 'Guest')}</span><span>${escape(formatTime(entry.timeUs / 1e6))}</span></button>`;
      }).join('') : '<span class="cp-none">No one by that name</span>'}</div></div>`;
  }

  return {
    // view: {name, here, best, recentBest}; here is whether that map is loaded in the game.
    html(view) {
      if (!view.here) return `<div class="rn-empty"><b>Load ${escape(view.name ?? 'the map')} to compare</b><p>Compare plays two runs of the map that’s loaded in the game.</p></div>`;
      if (!cinema) return `<div class="rn-empty"><b>Compare is unavailable</b><p>This version of Surfd doesn’t support it.</p></div>`;
      const list = sources(view);
      settle(list);
      const first = chosen(picks[0], list), second = chosen(picks[1], list);
      const status = cinema.status?.();
      const busy = starting || status?.phase === 'loading' || status?.phase === 'preparing';
      const ready = first?.load && second?.load && first.id !== second.id;
      const label = !busy ? 'Watch together' : status?.phase === 'preparing' ? 'Preparing the camera…' : 'Loading runs…';
      return `<section class="cp" aria-label="Compare two runs">
        ${slot(0, list)}${slot(1, list)}
        <div class="cp-go"><button type="button" class="rn-cta" data-compare="go"${ready && !busy ? '' : ' disabled'}${busy ? ' aria-busy="true"' : ''}><i class="rn-tri" aria-hidden="true"></i>${label}</button>
          <span class="cp-sum">${ready ? difference(first, second) : first?.id === second?.id ? 'Pick two different runs' : ''}</span></div>
        <p class="rn-caption"><span>Both runs play as ghosts with their lines, kept side by side. Drag the view to look around, scroll to zoom.</span></p>
      </section>`;
    },
    // Returns true when the click was Compare's, and whether to render again.
    click(target, view) {
      if (target.dataset.comparePick != null) {
        const index = Number(target.dataset.comparePick);
        picks[index] = target.dataset.id;
        board = null;
        return true;
      }
      if (target.dataset.compareBoard != null) {
        const index = Number(target.dataset.compareBoard);
        board = board === index ? null : index;
        filter = '';
        return true;
      }
      if (target.dataset.compare === 'go') { void start(view); return true; }
      return false;
    },
    input(target) {
      if (!target.matches?.('[data-compare-find]')) return false;
      filter = target.value.slice(0, 40);
      return true;
    },
    get starting() { return starting; },
    // Closing the panel while runs load cancels them.
    reset() { if (starting && !cinema?.active) cinema?.close(); board = null; filter = ''; request++; starting = false; },
  };

  async function start(view) {
    if (starting || !cinema) return;
    const list = sources(view), first = chosen(picks[0], list), second = chosen(picks[1], list);
    if (!first?.load || !second?.load || first.id === second.id) return;
    const id = ++request;
    starting = true;
    let opened = false, failure = null;
    try { opened = await cinema.open([{label: first.short, load: first.load}, {label: second.short, load: second.load}]); }
    catch (error) { failure = error; }
    if (id !== request) return;
    starting = false;
    if (opened) { board = null; onStarted(); return; }
    const error = failure?.message || cinema.status?.()?.error;
    if (error) onError(error);
  }
}
