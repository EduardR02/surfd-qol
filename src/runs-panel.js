// Run history popup: a summary of the session or map, one row per run, and
// splits and ramps for the run you click. Opened only from menus, like settings.
import {formatDelta, formatNumber, formatTime} from './hud-model.js';
import {summarize} from './run-history.js';

const escape = value => String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const loss = value => Number.isFinite(value) ? formatNumber(Math.max(0, value), 1) : '—';
const plain = (value, digits = 0) => Number.isFinite(value) ? formatNumber(value, digits) : '—';
const PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6L12.6 8z"/></svg>';

export const runsLauncherMarkup = `<button id="runs-open" class="launcher" type="button" aria-expanded="false" aria-controls="runs" hidden><span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>Runs</button>`;

export const runsMarkup = `
<section id="runs" role="dialog" aria-labelledby="runs-title" hidden>
  <header class="head">
    <h2 id="runs-title"><span class="mark" aria-hidden="true"></span>Runs</h2>
    <span class="seg" role="radiogroup" aria-label="Show runs from">
      <label><input type="radio" name="qol-runs-scope" value="session" data-scope checked><span>This session</span></label>
      <label><input type="radio" name="qol-runs-scope" value="map" data-scope><span>This map</span></label>
    </span>
    <button id="runs-close" class="close" type="button" aria-label="Close runs"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
  </header>
  <p id="runs-context" class="runs-context"></p>
  <div id="runs-tiles" class="tiles"></div>
  <p class="runs-hint">Click a run to see its checkpoints and every ramp, or Watch to replay it. Speeds and losses are in u/s; for losses, lower is better.</p>
  <p id="runs-message" class="runs-message" role="status" hidden></p>
  <div class="body runs-body">
    <table class="runs-table">
      <thead><tr>
        <th scope="col">Run</th><th scope="col" class="map-col">Map</th><th scope="col">Time</th><th scope="col">Result</th>
        <th scope="col" title="Speed as you left the start zone">Start speed</th>
        <th scope="col" title="How well your mouse and strafe keys matched, from the game">Sync</th>
        <th scope="col" title="Speed lost landing on ramps, all ramps added up">Board loss</th>
        <th scope="col" title="Speed lost while surfing ramps (Down + Up), all ramps added up">Ramp loss</th>
        <th scope="col" title="Speed lost in the air to braking and imperfect strafes, all flights added up">Air loss</th>
        <th scope="col">Top speed</th>
        <th scope="col"><span class="visually-hidden">Replay</span></th>
      </tr></thead>
      <tbody id="runs-rows"></tbody>
    </table>
    <p id="runs-empty" class="runs-empty" hidden></p>
  </div>
  <footer class="runs-foot">
    <span class="note">— means not measured (that HUD value was hidden). Saved in this browser; choose how much under QoL → History.</span>
    <button id="runs-clear" class="ghost" type="button">Clear map</button>
  </footer>
</section>`;

// Pure view model, so the popup's choices are testable without a DOM.
export function runsView(all, {scope = 'session', session, map} = {}) {
  const shownMap = map || all.at(-1)?.map || '';
  const list = scope === 'map' ? all.filter(run => run.map === shownMap) : all.filter(run => run.session === session);
  const maps = new Set(list.map(run => run.map));
  const mapName = (scope === 'map' ? list : all.filter(run => run.map === shownMap)).at(-1)?.mapName ?? '';
  // Splits compare against the best clean finish on the same map in this list.
  const bests = new Map();
  for (const run of list) {
    if (run.outcome !== 'finished' || run.practice || run.invalid) continue;
    const best = bests.get(run.map);
    if (!best || run.time < best.time) bests.set(run.map, run);
  }
  return {scope, map: shownMap, mapName, multipleMaps: maps.size > 1, summary: summarize(list), bests,
    rows: list.map((run, index) => ({run, number: index + 1, best: bests.get(run.map) === run})).reverse()};
}

function result(run) {
  const reached = run.checkpoints.length;
  const text = run.outcome === 'finished' ? 'Finished' : reached ? `Reset after ${run.kind ?? 'CP'}${reached}` : `Reset before ${run.kind ?? 'CP'}1`;
  const tags = [run.practice && 'Practice', run.invalid && 'Invalid'].filter(Boolean)
    .map(tag => `<span class="pill" title="${escape(tag === 'Invalid' ? `Invalid: ${run.invalid}. Never counts as best.` : 'Practice runs never count as best.')}">${tag}</span>`).join('');
  return `<span class="${run.outcome === 'finished' ? '' : 'dim'}">${text}</span>${tags}`;
}

function delta(value, reference, digits, lowerIsBetter) {
  if (!Number.isFinite(value) || !Number.isFinite(reference)) return '<td class="muted">—</td>';
  const difference = Number((value - reference).toFixed(digits));
  const tone = difference === 0 ? 'muted' : (difference < 0) === lowerIsBetter ? 'good' : 'loss';
  return `<td class="${tone}">${formatDelta(difference, digits)}</td>`;
}

// Says why Down and Up are missing, so a dash never looks like a bug.
function rampNote(ramps) {
  const notes = [];
  if (ramps.some(ramp => ramp.missing === 'hidden')) notes.push('Down and Up are only measured while Ramp is shown and Live feedback is off (QoL → Feedback).');
  if (ramps.some(ramp => ramp.missing === 'unclear')) notes.push('— on a ramp means its contact couldn’t be measured cleanly, e.g. ramp and wall at once.');
  return notes.map(note => `<p class="note">${note}</p>`).join('');
}

function detail(run, best, columns) {
  const comparing = best && best !== run;
  const versus = comparing ? `against your best run, ${formatTime(best.time)}` : best === run ? 'this is your best run' : 'no finished run to compare with yet';
  const checkpoints = run.checkpoints.length ? `
    <section><h4>Checkpoints <span>${versus}</span></h4>
    <table class="mini">
      <thead><tr><th scope="col"></th><th scope="col">Time</th><th scope="col">vs best</th><th scope="col">Speed</th><th scope="col">vs best</th></tr></thead>
      <tbody>${run.checkpoints.map((checkpoint, index) => `<tr><th scope="row">${run.kind ?? 'CP'}${index + 1}</th>
        <td>${formatTime(checkpoint.split)}</td>${comparing ? delta(checkpoint.split, best.checkpoints[index]?.split, 3, true) : '<td class="muted">—</td>'}
        <td>${plain(checkpoint.speed)}</td>${comparing ? delta(checkpoint.speed, best.checkpoints[index]?.speed, 0, false) : '<td class="muted">—</td>'}</tr>`).join('')}
      </tbody></table></section>` : '<section><h4>Checkpoints</h4><p class="note">No checkpoints reached.</p></section>';
  const ramps = run.ramps.length ? `
    <section><h4>Each ramp <span>speed lost, as on the HUD</span></h4>
    <table class="mini">
      <thead><tr><th scope="col"></th><th scope="col" title="Landing on the ramp">Board</th><th scope="col" title="From landing to the lowest point">Down</th>
        <th scope="col" title="From the lowest point to leaving the ramp">Up</th><th scope="col">Left at</th></tr></thead>
      <tbody>${run.ramps.map((ramp, index) => `<tr><th scope="row">Ramp ${index + 1}</th>
        <td>${loss(ramp.board)}</td><td>${loss(ramp.down)}</td><td>${loss(ramp.up)}</td><td>${plain(ramp.exit)}</td></tr>`).join('')}
      </tbody></table>${rampNote(run.ramps)}</section>` : '<section><h4>Each ramp</h4><p class="note">No ramps measured: Ramp feedback was hidden, or the run ended first.</p></section>';
  const height = run.start?.height;
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const facts = [
    `Left the start at <b>${plain(run.start?.speed, 1)} u/s</b>${Number.isFinite(height) ? `, ${formatNumber(Math.abs(height), 1)} u ${height < 0 ? 'below' : 'above'} the platform` : ''}.`,
    run.surf.count ? `Lost <b>${loss(run.surf.down)}</b> on the way down ramps and <b>${loss(run.surf.up)}</b> on the way up, over ${plural(run.surf.count, 'ramp')}.` : 'No ramp losses measured.',
    run.air.count ? `Lost <b>${loss(run.air.braking)}</b> to air braking and <b>${loss(run.air.missed)}</b> to missed strafe gain, over ${plural(run.air.count, 'flight')}.` : 'No air losses measured.',
    `Started at ${new Date(run.at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}.`,
  ];
  return `<tr class="detail"><td colspan="${columns}">
    <ul class="facts">${facts.map(fact => `<li>${fact}</li>`).join('')}</ul>
    <div class="detail-grid">${checkpoints}${ramps}</div></td></tr>`;
}

export function createRunsPanel({root, host, history, replays, replayControl, onOpen}) {
  const node = id => root.getElementById(id);
  const popup = node('runs'), opener = node('runs-open'), close = node('runs-close'), rows = node('runs-rows');
  const tiles = node('runs-tiles'), context = node('runs-context'), empty = node('runs-empty'), clear = node('runs-clear'), message = node('runs-message');
  const table = popup.querySelector('.runs-table'), body = popup.querySelector('.runs-body');
  let available = false, scope = 'session', expanded = null, confirming = false;

  function render() {
    if (popup.hidden || !history) return;
    const view = runsView(history.runs(), {scope, session: history.session, map: history.currentMap});
    const {summary} = view;
    const columns = view.multipleMaps ? 11 : 10;
    table.classList.toggle('with-map', view.multipleMaps);
    context.textContent = scope === 'map'
      ? view.mapName ? `Every saved run on ${view.mapName}` : 'No map played yet'
      : view.multipleMaps ? 'Runs since this page loaded, on every map' : `Runs since this page loaded${view.mapName && summary.count ? ` on ${view.mapName}` : ''}`;
    const tile = (label, value, sub = '') => `<div class="tile"><span class="tile-label">${label}</span><span class="tile-value">${value}</span><span class="tile-sub">${sub}</span></div>`;
    tiles.innerHTML = [
      tile('Runs', summary.count, `${summary.finished} finished`),
      tile('Best time', summary.best ? formatTime(summary.best.time) : '—',
        summary.best ? view.multipleMaps ? escape(summary.best.mapName) : `run ${view.rows.find(row => row.run === summary.best)?.number}` : 'no finish yet'),
      tile('Average finish', summary.average === null ? '—' : formatTime(summary.average), summary.finished ? `of ${summary.finished} finished` : ''),
      tile('Best start speed', plain(summary.bestStart, 1), summary.averageStart === null ? '' : `${plain(summary.averageStart, 1)} on average`),
      tile('Average sync', summary.averageSync === null ? '—' : `${summary.averageSync.toFixed(1)}%`, summary.count ? `over ${summary.count} run${summary.count === 1 ? '' : 's'}` : ''),
    ].join('');
    empty.hidden = view.rows.length > 0;
    empty.textContent = scope === 'map' && !view.map ? 'Play a map to start its history.' : 'No runs yet. A run starts when you leave the start zone.';
    rows.innerHTML = view.rows.map(({run, number, best}) => {
      const open = expanded === run.id;
      const ramps = run.surf.count ? `title="${loss(run.surf.down)} down + ${loss(run.surf.up)} up, over ${run.surf.count} ramps"` : '';
      return `<tr class="run${best ? ' best' : ''}${open ? ' open' : ''}" data-run="${escape(run.id)}" tabindex="0" aria-expanded="${open}">
        <td class="dim"><span class="chevron" aria-hidden="true"></span>${number}</td><td class="map-col">${escape(run.mapName)}</td>
        <td class="run-time">${formatTime(run.time)}${best ? '<span class="pill best-pill">Best</span>' : ''}</td>
        <td>${result(run)}</td><td>${plain(run.start?.speed)}</td>
        <td>${Number.isFinite(run.sync) ? `${run.sync.toFixed(1)}%` : '—'}</td>
        <td title="${run.board.count} boards">${run.board.count ? loss(run.board.total) : '—'}</td>
        <td ${ramps}>${run.surf.count ? loss(run.surf.loss) : '—'}</td>
        <td title="${run.air.count} flights">${run.air.count ? loss(run.air.loss) : '—'}</td>
        <td>${plain(run.topSpeed)}</td>
        <td class="watch-cell">${replayControl?.canWatch(run)
          ? `<button class="watch" type="button" data-watch="${escape(run.id)}" aria-label="Watch run ${number}">${PLAY_ICON}Watch</button>`
          : `<span class="dim" title="${run.replay ? 'This replay is no longer saved.' : 'No replay was saved for this run.'}">—</span>`}</td></tr>${open ? detail(run, view.bests.get(run.map), columns) : ''}`;
    }).join('');
    clear.hidden = !view.map || !history.runs().some(run => run.map === view.map);
    clear.textContent = confirming ? 'Clear all runs on this map?' : 'Clear map';
    clear.classList.toggle('danger', confirming);
  }
  function toggleRow(target) {
    const row = target.closest?.('tr.run');
    if (!row) return;
    expanded = expanded === row.dataset.run ? null : row.dataset.run;
    render();
    root.querySelector(`tr.run[data-run="${CSS.escape(row.dataset.run)}"]`)?.focus();
  }
  function say(text) {
    message.hidden = !text;
    message.textContent = text;
  }
  async function watch(id) {
    const run = history.runs().find(entry => entry.id === id);
    if (!run || !replayControl) return;
    say('Loading the replay…');
    try {
      await replayControl.watch(run);
      say('');
      hide();
    } catch (error) {
      say(`Couldn’t play this run: ${error?.message ?? error}`);
    }
  }
  rows.addEventListener('click', event => {
    const button = event.target.closest?.('[data-watch]');
    if (button) watch(button.dataset.watch);
    else toggleRow(event.target);
  });
  rows.addEventListener('keydown', event => {
    if (event.target.closest?.('[data-watch]')) return;
    if (event.code === 'Enter' || event.code === 'Space') { event.preventDefault(); toggleRow(event.target); }
  });
  for (const input of popup.querySelectorAll('[data-scope]')) input.addEventListener('change', () => {
    if (!input.checked) return;
    scope = input.value;
    expanded = null; confirming = false;
    body.scrollTop = 0;
    render();
  });
  clear.addEventListener('click', () => {
    if (!confirming) { confirming = true; render(); return; }
    confirming = false;
    const map = runsView(history.runs(), {scope, session: history.session, map: history.currentMap}).map;
    history?.clear(map);
    replays?.clearMap(map);
  });
  const unsubscribers = [history?.subscribe(render), replays?.subscribe(render)].filter(Boolean);

  function hide(focus = false) {
    popup.hidden = true;
    confirming = false;
    opener.setAttribute('aria-expanded', 'false');
    if (focus && available) opener.focus();
  }
  function show() {
    onOpen?.();
    popup.hidden = false;
    opener.setAttribute('aria-expanded', 'true');
    render();
    close.focus();
  }
  opener.addEventListener('click', () => {
    if (!available) return;
    if (!popup.hidden) hide(true); else show();
  });
  close.addEventListener('click', () => hide(true));

  return {
    render,
    close: hide,
    get open() { return !popup.hidden; },
    handleKey(event) {
      if (popup.hidden || !available) return;
      if (event.type === 'keydown' && event.code === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); hide(true); return;
      }
      // Keep popup keystrokes out of the game's global keyboard handlers.
      if (event.composedPath().includes(host)) event.stopPropagation();
    },
    setAvailable(next) {
      available = next;
      if (opener.hidden === next) opener.hidden = !next;
      if (!next && !popup.hidden) hide();
    },
    // Dev harness hook.
    show(nextScope) {
      available = true;
      opener.hidden = false;
      if (nextScope === 'map' || nextScope === 'session') {
        scope = nextScope;
        for (const input of popup.querySelectorAll('[data-scope]')) input.checked = input.value === scope;
      }
      show();
    },
    destroy() { for (const unsubscribe of unsubscribers) unsubscribe(); },
  };
}
