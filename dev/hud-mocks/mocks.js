// Surfd QoL HUD concepts. Plain script (works from file:// too): data for four moments,
// ten concept renderers that each return a FULL and a SURFING HUD, and the gallery wiring.
(() => {
'use strict';

/* ------------------------------------------------------------------ data */
// One ramp, graded as the live model would: board on fixed thresholds, down/up/surf
// against the KSF ramp reference (tolerance 2), air on fixed thresholds.
const ramp = staleSplit => ({
  board: {v: '−2.6', t: 'good'},
  down: {v: '−14.6', t: 'good', stale: staleSplit},
  up: {v: '−38.1', t: 'loss', stale: staleSplit},
  surf: {v: '−52.7', t: 'loss', stale: staleSplit},
  air: {v: '−3.2', t: 'good'},
  loss: {board: 2.6, down: 14.6, up: 38.1, surf: 52.7, air: 3.2},
  ref: {down: 15.2, up: 31.4, surf: 46.6},
});
const cp1 = {
  label: 'CP1', time: '00:16.771', speed: '2979',
  pb: {dt: '−0.081', dtTone: 'good', dv: '+38', dvTone: 'good', s: -0.081},
  ksf: {dt: '+0.177', dtTone: 'loss', dv: '−39', dvTone: 'loss', s: 0.177},
};
const SYNC = {text: '91.3%', tone: 'warn'};
const MOMENTS = {
  1: {name: 'Leaving the start', short: 'Start',
    note: '0.9 s after the start zone, strafing towards the first ramp. Exit speed and height are up; sync still matters.',
    speed: '371', energy: 'good', time: '00:00.884', label: '', sync: SYNC, early: true,
    start: {speed: '349.6', speedTone: 'good', cap: '−0.4', height: '4.2', heightTone: 'good'},
    cp: null, ramp: null, fresh: ['start'], events: ['start']},
  2: {name: 'CP1, mid-air', short: 'CP1 mid-air',
    note: '0.6 s after CP1, airborne off a ramp: the checkpoint deltas, that ramp\'s board/down/up and the flight before it. The busiest moment of a ranked run.',
    speed: '3046', energy: 'loss', time: '00:17.412', label: '', sync: SYNC, early: false,
    start: null, cp: cp1, ramp: ramp(false), fresh: ['cp'], events: ['cp', 'surf', 'land']},
  3: {name: 'Mid-ramp, later', short: 'Mid-ramp',
    note: 'Surfing a ramp at 00:41. Just landed: board and air are new, the down/up split still describes the previous ramp.',
    speed: '3412', energy: 'neutral', time: '00:41.208', label: '', sync: SYNC, early: false,
    start: null, cp: null, ramp: ramp(true), fresh: ['board', 'air'], events: ['land', 'surf']},
  4: {name: 'Replay, busiest', short: 'Replay',
    note: 'The same CP1 moment, watched as a replay: everything on, and you have time to read it.',
    speed: '3046', energy: 'good', time: '00:17.412', label: 'REPLAY', sync: SYNC, early: false,
    start: null, cp: cp1, ramp: ramp(false), fresh: ['cp'], events: ['cp', 'surf', 'land']},
};
const BACKDROPS = ['snow', 'neon', 'dark', 'warm', 'fog', 'ice'];
const TINTS = {auto: 'As captured', neutral: 'Rose', good: 'Gaining', loss: 'Losing'};

/* --------------------------------------------------------------- helpers */
// Whole part loud, fraction quiet: the eye lands on "−52" or "00:17" first.
function N(s, cls = '') {
  const i = s.lastIndexOf('.');
  return i > 0 ? `<b class="${cls}">${s.slice(0, i)}<span class="f">${s.slice(i)}</span></b>` : `<b class="${cls}">${s}</b>`;
}
const T = (s, cls = '') => `<b class="tm ${cls}">${s}</b>`;
const tone = x => x.stale ? 'stale' : x.t;
const X = (x, cls = '') => x ? N(x.v, `${tone(x)} ${cls}`) : '';
const lab = (s, cls = '') => `<span class="lab ${cls}">${s}</span>`;
const slot = (x, name, cls = '', withLab = true) => `<div class="slot ${cls}">${x ? X(x) : ''}${x && withLab ? lab(name) : ''}</div>`;
const dt = (r, cls = 'dt') => `<b class="${cls} ${r.dtTone}">${r.dt}</b>`;
const dv = (r, cls = 'dv') => `<b class="${cls} ${r.dvTone}">${r.dv}</b>`;
const pr = (r, after = '') => `<span class="pr">${dt(r)}${dv(r)}${after}</span>`;
const spd = (d, inner = '') => `<div class="spd e-${d.energy}">${d.speed}${inner}</div>`;
const sync = (d, cls = 'sy') => d.sync ? `<b class="${cls} ${d.sync.tone}">${d.sync.text}</b>` : '';
const tag = d => d.label ? `<span class="tag">${d.label}</span>` : '';
const cpHead = cp => `${lab(cp.label)}${T(cp.time)}<b class="rose">${cp.speed}</b>`;
const startSlots = d => `<div class="slot">${N(d.start.speed, d.start.speedTone)}${lab('start')}</div><div class="slot">${N(d.start.height, d.start.heightTone)}${lab('height')}</div>`;
const fullRamp = R => `${slot(R.air, 'air')}<span class="gap"></span>${slot(R.board, 'board')}${slot(R.down, 'down')}${slot(R.up, 'up')}${slot(R.surf, 'surf', 'net')}`;
const surfRamp = (R, labels = false) => `${slot(R.board, 'board', 'side', labels)}${slot(R.surf, 'surf', 'net', labels)}${slot(R.air, 'air', 'side', labels)}`;

/* -------------------------------------------------------------- concepts */
// Each render(d, full) returns the inner HTML of a zero-size anchor at the speed's centre.

function axis(d, full) {
  const h = [spd(d)], R = d.ramp, cp = d.cp;
  if (full) {
    const ev = cp ? `<div class="cp-head">${cpHead(cp)}</div><div class="refs"><div class="slot">${pr(cp.pb)}${lab('pb')}</div><div class="slot">${pr(cp.ksf)}${lab('ksf')}</div></div>`
      : d.start ? `<div class="start">${startSlots(d)}</div>` : '';
    h.push(`<div class="events">${ev}</div>`);
    h.push(`<div class="clock">${sync(d)}${T(d.time)}${tag(d)}</div>`);
    if (R) h.push(`<div class="row ramp">${fullRamp(R)}</div>`);
  } else {
    // The row above the speed is shared: checkpoint deltas, then the start, then the clock.
    if (cp) h.push(`<div class="events"><div class="refs"><div class="slot">${pr(cp.pb)}${lab('pb')}</div><div class="slot">${pr(cp.ksf)}${lab('ksf')}</div></div></div>`);
    else if (d.start) h.push(`<div class="events"><div class="start">${startSlots(d)}</div></div>`);
    else h.push(`<div class="clock">${T(d.time)}${tag(d)}</div>`);
    if (d.label && (cp || d.start)) h.push(`<div class="lone-tag">${tag(d)}</div>`);
    // Sync holds the ramp row until the first ramp result replaces it.
    if (R) h.push(`<div class="row ramp">${surfRamp(R, true)}</div>`);
    else if (d.early) h.push(`<div class="row ramp"><div class="slot net">${sync(d, 'sy')}${lab('sync')}</div></div>`);
  }
  return h.join('');
}

function verdict(d, full) {
  const h = [spd(d)], R = d.ramp, cp = d.cp;
  if (!full) {
    if (cp) {
      h.push(`<div class="row head">${dt(cp.pb)}${dv(cp.pb)}</div>`);
      h.push(`<div class="row sub">${dt(cp.ksf)}${dv(cp.ksf)}</div>`);
    } else if (d.start) {
      h.push(`<div class="row startv"><div class="slot">${N(d.start.cap, d.start.speedTone)}${lab('cap')}</div><div class="slot">${N('+' + d.start.height, d.start.heightTone)}${lab('height')}</div></div>`);
    }
    if (d.label) h.push(`<div class="row tagrow">${tag(d)}</div>`);
    if (R) h.push(`<div class="row ramp">${X(R.surf, 'net')}${X(R.air, 'air')}</div>`);
    else if (d.early) h.push(`<div class="row ramp">${sync(d)}</div>`);
    return h.join('');
  }
  // Verdicts hug the speed; their evidence wraps around them, quieter.
  h.push(`<div class="row run">${tag(d)}${T(d.time)}<span>${sync(d)}${lab('sync', 'il')}</span></div>`);
  if (cp) {
    h.push(`<div class="row cpe">${cpHead(cp)}</div>`);
    h.push(`<div class="row cpv">${pr(cp.pb, lab('pb'))}${pr(cp.ksf, lab('ksf'))}</div>`);
  } else if (d.start) {
    h.push(`<div class="row cpe">${lab('exit', 'ip')}${N(d.start.speed)}</div>`);
    h.push(`<div class="row cpv"><span class="pr">${N(d.start.cap, d.start.speedTone + ' dt')}${lab('cap')}</span><span class="pr">${N('+' + d.start.height, d.start.heightTone + ' dt')}${lab('height')}</span></div>`);
  }
  if (R) {
    h.push(`<div class="row rampv"><span>${X(R.surf)}${lab('surf', 'il')}</span><span>${X(R.air)}${lab('air', 'il')}</span></div>`);
    h.push(`<div class="row rampe"><span>${lab('board', 'ip')}${X(R.board)}</span><span>${lab('down', 'ip')}${X(R.down)}</span><span>${lab('up', 'ip')}${X(R.up)}</span></div>`);
  }
  return h.join('');
}

function matrix(d, full) {
  const h = [], R = d.ramp, cp = d.cp;
  const cell = inner => `<span class="cell">${inner}</span>`;
  const startCell = (v, t, name) => `<span class="cell">${N(v, 'startc ' + t)}${lab(name, 'u')}</span>`;
  // Rows are quantities (time, speed); columns are references (PB | live | KSF).
  // The start's exit speed and height flank the timer for 1.8 s, as the checkpoint's time gaps do.
  const tl = cp ? cell(dt(cp.pb)) : d.start ? startCell(d.start.speed, d.start.speedTone, 'start') : cell('');
  const tr = cp ? cell(dt(cp.ksf)) : d.start ? startCell(d.start.height, d.start.heightTone, 'height') : cell('');
  h.push(`<div class="r r-time">${tl}${T(d.time)}${tr}</div>`);
  h.push(`<div class="r r-speed">${cell(cp ? dv(cp.pb) : '')}<b class="big e-${d.energy}">${d.speed}</b>${cell(cp ? dv(cp.ksf) : '')}</div>`);
  if (full) {
    if (cp) h.push(`<div class="r r-head">${cell(lab('pb'))}<span class="cph">${cpHead(cp)}</span>${cell(lab('ksf'))}</div>`);
    h.push(`<div class="row r-top" style="bottom:${cp ? 104 : 76}px"><span>${sync(d)} ${lab('sync')}</span>${tag(d)}</div>`);
    if (R) h.push(`<div class="row ramp">${fullRamp(R)}</div>`);
  } else {
    if (d.label) h.push(`<div class="row r-top" style="bottom:76px">${tag(d)}</div>`);
    if (R) h.push(`<div class="row ramp">${surfRamp(R)}</div>`);
    else if (d.early) h.push(`<div class="row ramp"><div class="slot net">${sync(d, '')}${lab('sync')}</div></div>`);
  }
  return h.join('');
}

function strip(d, full) {
  const h = [spd(d), '<div class="axis"></div>'], R = d.ramp, cp = d.cp;
  const il = s => full ? lab(s, 'il') : '';
  let L = [], Rt = [];
  // Left of the axis: where you are in the run (the clock, or the checkpoint or start
  // that borrows its place). Right: how the last ramp went. Most important nearest the axis.
  if (cp) L = [`<span class="outer">${pr(cp.ksf, il('ksf'))}</span>`, pr(cp.pb, il('pb'))];
  else if (d.start) L = [`<span class="outer">${N(d.start.height, d.start.heightTone)}${il('height')}</span>`, `<span>${N(d.start.speed, d.start.speedTone)}${il('start')}</span>`];
  else if (!full) L = [T(d.time, 'clk')];
  if (R) Rt = [`<span>${X(R.surf)}${il('surf')}</span>`, `<span class="outer">${X(R.air)}${il('air')}</span>`];
  else if (d.early && !full) Rt = [`<span>${sync(d, '')}</span>`];
  h.push(`<div class="half l">${L.join('')}</div><div class="half r">${Rt.join('')}</div>`);
  if (full) h.push(`<div class="row clockrow"><span>${sync(d)}${lab('sync', 'il')}</span>${T(d.time)}${tag(d)}</div>`);
  else if (d.label) h.push(`<div class="row clockrow">${tag(d)}</div>`);
  if (full) {
    if (cp) h.push(`<div class="detail l">${cpHead(cp)}</div>`);
    if (R) h.push(`<div class="detail r"><span>${lab('board', 'ip')} ${X(R.board)}</span><span>${lab('down')} ${X(R.down)}</span><span>${lab('up')} ${X(R.up)}</span></div>`);
  }
  return h.join('');
}

function halo(d, full) {
  const h = [spd(d)], R = d.ramp, cp = d.cp;
  // Events flash beside the crosshair, where the eyes already are; persistent values stay low.
  if (cp) h.push(`<div class="x l">${dt(cp.pb)}${dv(cp.pb)}${full ? lab('pb') : ''}</div><div class="x r">${dt(cp.ksf)}${dv(cp.ksf)}${full ? lab('ksf') : ''}</div>`);
  else if (d.start) h.push(`<div class="x l">${N(d.start.speed, 'sv ' + d.start.speedTone)}${lab('start')}</div><div class="x r">${N(d.start.height, 'sv ' + d.start.heightTone)}${lab('height')}</div>`);
  h.push(`<div class="row clock">${full ? sync(d) : ''}${T(d.time)}${tag(d)}</div>`);
  if (full && cp) h.push(`<div class="row cph">${cpHead(cp)}</div>`);
  if (R) h.push(`<div class="row ramp">${full ? fullRamp(R) : surfRamp(R)}</div>`);
  else if (d.early && !full) h.push(`<div class="row ramp"><div class="slot net">${sync(d, '')}</div></div>`);
  return h.join('');
}

function meter(d, full) {
  const h = [spd(d)], R = d.ramp, cp = d.cp;
  // The surf bar is scaled so the KSF ramp loss spans the speed's width: match the
  // record and the bar ends under the last digit; anything past the tick is lost.
  const W = full ? 260 : 172, x0 = -W / 2, y = full ? 46 : 47;
  const bar = (x, w, cls) => `<div class="bar ${cls}" style="left:${x.toFixed(1)}px;top:${y}px;width:${Math.max(2, w).toFixed(1)}px"></div>`;
  // A value centred under part of the bar.
  const under = (center, x, cls = '') => N(x.v, `uv ${tone(x)} ${cls}" style="left:${center.toFixed(1)}px;top:${y + 13}px`);
  if (R) {
    const k = W / R.ref.surf, g = 2;
    // Down includes the board, so its segment is what came after the board.
    const segs = [[R.loss.board, R.board.t], [R.loss.down - R.loss.board, R.down.t], [R.loss.up, R.up.t]];
    let x = x0;
    const stale = R.surf.stale;
    segs.forEach(([v, t], i) => { h.push(bar(x, v * k - (i < 2 ? g : 0), `${t}${stale ? ' ghost' : ''}`)); x += v * k; });
    if (stale) h.push(bar(x0, R.loss.board * k - g, R.board.t)); // the new ramp's board, drawn over the ghost of the last
    const ax = R.loss.air * k;
    h.push(bar(x0 - 9 - ax, ax, R.air.t));
    h.push(`<div class="tick" style="left:${x0 + W - 1}px;top:${y - 4}px"></div>`);
    if (full) h.push(`<div class="row ramp" style="top:${y + 22}px">${fullRamp(R)}</div>`);
    // Surfing: what the last flight cost under the air segment, what this ramp cost
    // (board included) under the ramp. Every loss since the last ramp, left to right.
    // Right after boarding, the current ramp has cost only its board so far.
    else h.push(under(x0 - 9 - ax / 2, R.air), under((x0 + Math.max(x, x0 + 40)) / 2, stale ? R.board : R.surf));
  }
  // The start borrows the checkpoint's spots: exit speed left, height right, and in
  // surfing mode sync between them, gone with them after 1.8 s.
  const start = (mid = '') => `<div class="row cp startrow">${N(d.start.speed, 'dt ' + d.start.speedTone)}${mid}${N(d.start.height, 'dt ' + d.start.heightTone)}</div>`;
  if (full) {
    if (cp) h.push(`<div class="cpblock"><div class="cph">${cpHead(cp)}</div><div class="refs"><div class="slot">${pr(cp.pb)}</div><div class="slot">${pr(cp.ksf)}</div></div></div>`);
    else if (d.start) h.push(`<div class="cpblock"><div class="refs"><div class="slot">${N(d.start.speed, 'dt ' + d.start.speedTone)}</div><div class="slot">${N(d.start.height, 'dt ' + d.start.heightTone)}</div></div></div>`);
    h.push(`<div class="row clock${d.sync ? '' : ' alone'}">${sync(d)}${T(d.time)}${tag(d)}</div>`);
  } else {
    if (cp) h.push(`<div class="row cp">${pr(cp.pb)}${pr(cp.ksf)}</div>`);
    else if (d.start) h.push(start(sync(d, 'sy mid')));
    else h.push(`<div class="row clock">${T(d.time)}${tag(d)}</div>`);
    if (d.label && cp) h.push(`<div class="row" style="bottom:82px">${tag(d)}</div>`);
  }
  return h.join('');
}

function feed(d, full) {
  const h = [spd(d)], R = d.ramp, cp = d.cp;
  // A run log: each event is one line, its type hanging in the margin left of the speed's first digit.
  const ev = s => `<span class="ev">${s}</span>`, hang = s => `<span class="ev hang">${s}</span>`;
  const lines = {
    start: () => `${hang('start')}${N(d.start.speed, d.start.speedTone)}${ev('height')}${N(d.start.height, d.start.heightTone)}`,
    cp: () => full
      ? `${hang(cp.label)}<span class="grp">${dt(cp.pb, '')}${dv(cp.pb)}${ev('pb')}</span><span class="grp">${dt(cp.ksf, '')}${dv(cp.ksf)}${ev('ksf')}</span><span class="grp sm">${T(cp.time)}<b class="rose">${cp.speed}</b></span>`
      : `${hang(cp.label)}<span class="grp">${dt(cp.pb, '')}${dv(cp.pb)}</span><span class="grp">${dt(cp.ksf, '')}${dv(cp.ksf)}</span>`,
    surf: () => full
      ? `${hang('surf')}${X({...R.surf, stale: false})}<span class="grp sm">${ev('down')}${X({...R.down, stale: false})}${ev('up')}${X({...R.up, stale: false})}</span>`
      : `${hang('surf')}${X({...R.surf, stale: false})}`,
    land: () => `${hang('air')}${X(R.air)}${ev('board')}${X(R.board)}`,
  };
  // Newest event nearest the speed; older ones step away and fade.
  const shown = d.events.slice(0, full ? 3 : 2);
  h.push(`<div class="feed">${shown.map((key, age) => `<div class="ln age${age}">${lines[key]()}</div>`).join('')}</div>`);
  h.push(`<div class="row clock">${full || d.early ? sync(d) : ''}${T(d.time)}${tag(d)}</div>`);
  return h.join('');
}

// Meter's bar drawn as Monolith's rule: widths are percentages of the speed's own width,
// so the KSF ramp loss always spans the number exactly, whatever its digit count.
function underBar(d) {
  const R = d.ramp, seg = (left, width, cls, gap = 2) => `<i class="seg ${cls}" style="left:${left.toFixed(2)}%;width:calc(${width.toFixed(2)}% - ${gap}px)"></i>`;
  let out = '';
  if (R) {
    const ref = R.ref.surf, ghost = R.surf.stale ? ' ghost' : '';
    let x = 0;
    [[R.loss.board, R.board.t], [R.loss.down - R.loss.board, R.down.t], [R.loss.up, R.up.t]].forEach(([v, t], i) => {
      out += seg(x / ref * 100, v / ref * 100, t + ghost, i < 2 ? 2 : 0); x += v;
    });
    if (ghost) out += seg(0, R.loss.board / ref * 100, R.board.t);
    out += `<i class="seg air ${R.air.t}" style="width:${(R.air.loss / ref * 100).toFixed(2)}%"></i><i class="ref"></i>`;
  } else if (d.early) {
    out += `<i class="seg track" style="left:0;width:100%"></i>${seg(0, (91.3 - 70) / 30 * 100, d.sync.tone, 0)}<i class="ref" style="left:calc(${(25 / 30 * 100).toFixed(2)}% - 1px)"></i>`;
  }
  return out;
}

function monolith(d, full, bar = false) {
  const R = d.ramp, cp = d.cp;
  // Everything hangs off the speed itself: a rule beneath it, marks on its right shoulder.
  const ruleTone = R ? tone(R.surf) === 'stale' ? `${R.surf.t} dim` : R.surf.t : d.early ? d.sync.tone : '';
  let inner = bar ? underBar(d) : ruleTone ? `<i class="rule ${ruleTone}"></i>` : '';
  const sup = !full && cp ? dt(cp.pb, 'side sup') : !full && d.start ? N(d.start.speed, 'side sup ' + d.start.speedTone) : '';
  const sub = !full && cp ? dt(cp.ksf, 'side sub') : !full && d.start ? N(d.start.height, 'side sub ' + d.start.heightTone) : '';
  const rv = R ? N(R.surf.v, `side rv ${tone(R.surf)}`) : d.early ? N(d.sync.text, `side rv ${d.sync.tone}`) : '';
  inner += sup + sub + rv;
  if (full) {
    const row = (k, v) => `<span class="k">${k}</span><span class="v">${v}</span>`;
    const rows = [];
    if (d.label) rows.push(`<span class="k"></span><span class="v">${tag(d)}</span>`);
    rows.push(row('time', T(d.time)), row('sync', sync(d, '')), '<i class="gap"></i>');
    if (cp) rows.push(row(cp.label, `${T(cp.time)}<b class="rose">${cp.speed}</b>`), row('pb', `${dt(cp.pb, '')}${dv(cp.pb, '')}`), row('ksf', `${dt(cp.ksf, '')}${dv(cp.ksf, '')}`), '<i class="gap"></i>');
    if (d.start) rows.push(row('start', N(d.start.speed, d.start.speedTone)), row('height', N(d.start.height, d.start.heightTone)), '<i class="gap"></i>');
    if (R) rows.push(row('air', X(R.air)), row('board', X(R.board)), row('down', X(R.down)), row('up', X(R.up)));
    inner += `<div class="plaque">${rows.join('')}</div>`;
  }
  const h = [spd(d, inner)];
  if (!full && d.label) h.push(`<div class="row tagrow">${tag(d)}</div>`);
  return h.join('');
}

function race(d, full) {
  const h = [spd(d)], R = d.ramp, cp = d.cp;
  // Ghosts on a track: you are the tick in the middle; a ghost behind you (left) means you are ahead.
  const K = 300, lane = (r, name, top) => {
    const x = 75 + Math.max(-68, Math.min(68, r.s * K));
    return `<div class="lane" style="top:${top}px"><div class="trk"></div><div class="you"></div><div class="gh ${r.dtTone}" style="left:${x}px"></div>
      <span class="num">${dt(r)}${dv(r)}</span>${full ? `<span class="nm">${lab(name)}</span>` : ''}</div>`;
  };
  const base = full ? 80 : 44;
  if (cp) {
    h.push(`<div class="lanes" style="bottom:${base}px">${lane(cp.ksf, 'ksf', -48)}${lane(cp.pb, 'pb', -20)}</div>`);
    if (full) h.push(`<div class="row cph" style="bottom:${base + 58}px">${cpHead(cp)}</div>`);
  } else if (d.start) h.push(`<div class="row startrow" style="bottom:${base}px"><div class="slot">${N(d.start.speed, d.start.speedTone)}${lab('start')}</div><div class="slot">${N(d.start.height, d.start.heightTone)}${lab('height')}</div></div>`);
  if (full || !(cp || d.start)) h.push(`<div class="row clock">${full ? sync(d) : ''}${T(d.time)}${tag(d)}</div>`);
  else if (d.label) h.push(`<div class="row" style="bottom:${cp ? 108 : 96}px">${tag(d)}</div>`);
  if (R) h.push(`<div class="row ramp">${full ? fullRamp(R) : surfRamp(R)}</div>`);
  else if (d.early && !full) h.push(`<div class="row ramp"><div class="slot net">${sync(d, '')}</div></div>`);
  return h.join('');
}

function recency(d, full) {
  const h = [spd(d)], R = d.ramp, cp = d.cp;
  const fr = key => d.fresh.includes(key) ? 'fresh' : 'settled';
  // Size follows freshness: what just happened is big, then settles to a quiet resting size.
  let ev = '';
  if (cp) ev = `${full ? `<div class="cph">${cpHead(cp)}</div>` : ''}<div class="refs ${fr('cp')}"><div class="slot">${pr(cp.pb)}${lab('pb')}</div><div class="slot">${pr(cp.ksf)}${lab('ksf')}</div></div>`;
  else if (d.start) ev = `<div class="start">${[['speed', 'start'], ['height', 'height']].map(([k, name]) => `<div class="slot ${fr('start')}">${N(d.start[k], d.start[k + 'Tone'])}${lab(name)}</div>`).join('')}</div>`;
  if (ev) h.push(`<div class="events">${ev}</div>`);
  if (full || !ev) h.push(`<div class="row clock">${full || d.early ? sync(d) : ''}${T(d.time)}${tag(d)}</div>`);
  else if (d.label) h.push(`<div class="row" style="bottom:${cp ? 104 : 100}px">${tag(d)}</div>`);
  const rs = (x, name, key, cls = '') => `<div class="slot ${fr(key)} ${cls}">${X(x)}${lab(name)}</div>`;
  if (R) h.push(`<div class="row ramp">${full
    ? `${rs(R.air, 'air', 'air')}${rs(R.board, 'board', 'board')}${rs(R.down, 'down', 'surf')}${rs(R.up, 'up', 'surf')}${rs(R.surf, 'surf', 'surf')}`
    : `${rs(R.board, 'board', 'board')}${rs(R.surf, 'surf', 'surf')}${rs(R.air, 'air', 'air')}`}</div>`);
  else if (d.early && !full) h.push(`<div class="row ramp"><div class="slot settled">${sync(d, '')}${lab('sync')}</div></div>`);
  return h.join('');
}

// Today's HUD (src/hud-view.js + hud-styles.js) with the same data, for reference.
// Full = everything on; the right-hand frame is Zen mode, today's only reduced HUD.
function today(d, full) {
  const h = [`<div class="spd e-${d.energy}">${d.speed}</div>`], R = d.ramp, cp = d.cp;
  const tslot = (x, name, stale = false) => `<div class="slot${stale ? ' stale-slot' : ''}">${x ? X(x, 'val') : '<b class="val muted">—</b>'}${lab(name)}</div>`;
  const start = d.start ? `<div class="start"><div class="slot"><b class="val ${d.start.speedTone}">350</b>${lab('start')}</div><div class="slot">${N('+' + d.start.height, 'val ' + d.start.heightTone)}${lab('height')}</div></div>` : '';
  if (!full) {
    if (start) h.push(`<div class="events zen">${start}</div>`);
    return h.join('');
  }
  const split = cp ? `<div class="split"><div class="split-head"><span class="cp">${cp.label}</span><b class="split-time">${cp.time}</b><b class="split-speed">${cp.speed}</b></div>
    <div class="refs"><div class="ref"><span class="pair"><b class="dt ${cp.pb.dtTone}">${cp.pb.dt}</b><b class="ds ${cp.pb.dvTone}">${cp.pb.dv}</b></span>${lab('PB')}</div>
    <div class="ref"><span class="pair"><b class="dt ${cp.ksf.dtTone}">${cp.ksf.dt}</b><b class="ds ${cp.ksf.dvTone}">${cp.ksf.dv}</b></span>${lab('KSF')}</div></div></div>` : '';
  h.push(`<div class="events">${split}${start}</div>`);
  h.push(`<div class="clock"><b class="sy ${d.sync.tone}">${d.sync.text}</b><b class="time">${d.time}</b><span class="state">${d.label}</span></div>`);
  // One shared slot: the newer of the ramp (DOWN) and the flight (AIR); UP goes stale under a flight.
  const flightNewer = !R || R.surf.stale;
  h.push(`<div class="feedback">${tslot(R?.board, 'board')}${flightNewer ? tslot(R?.air, 'air') : tslot(R.down, 'down')}${tslot(R?.up, 'up', flightNewer)}</div>`);
  return h.join('');
}

/* ----------------------------------------------------------- concept copy */
const TODAY = {id: 'today', cls: 'td', name: 'Today', render: today};
const CONCEPTS = [
  {id: 'axis', cls: 'ax', name: 'Axis', render: axis,
    idea: 'Today\'s centre stack, disciplined. One vertical axis, four type sizes, every row with a single job. The row above the speed is shared: the clock lives there until a checkpoint or the start borrows it.',
    drops: 'The checkpoint\'s own time and speed go, and the deltas take the clock\'s row for 6.5 s. Down and up fold into surf, with board and air as quieter neighbours. Sync holds the ramp row until the first ramp result replaces it.',
    adjust: 'The labels under every value are the least necessary thing here. Once the slots are learned I would drop them in surfing mode and keep them in full.'},
  {id: 'verdict', cls: 'vd', name: 'Verdict', render: verdict,
    idea: 'Only judgements, no readings. At a checkpoint, the gap to your PB is the headline, more than half the speed\'s size, with KSF above it. In full mode every verdict hugs the speed and its evidence wraps around it, quieter.',
    drops: 'The timer, the split itself, board, down/up and every label go. Board is already inside surf, because down includes the board. The start becomes a delta to the 350 cap (−0.4) rather than 349.6.',
    adjust: 'Dropping the timer is the bet. If it feels naked, put the timer back at 14 px in muted grey. The PB-over-KSF hierarchy should follow the checkpoint reference setting.'},
  {id: 'matrix', cls: 'mx', name: 'Matrix', render: matrix,
    idea: 'A 3×2 grid you learn once. Rows are quantities: time on top, speed below. Columns are references: PB on the left, the live value in the middle, KSF on the right. Every delta sits beside the number it modifies.',
    drops: 'Column headers, the split row and down/up go. The live timer and speed stay in the middle column, so the deltas never need a label: left is you against you, right is you against the world.',
    adjust: 'At the start, exit speed and height borrow the PB and KSF cells beside the timer, which bends the rule a little. I would show tiny pb and ksf labels for the first few runs, then hide them.'},
  {id: 'strip', cls: 'st', name: 'Strip', render: strip,
    idea: 'The speed stands alone with one ruler-straight line under it. A short tick on the axis splits that line. Left of it is where you are in the run: the clock, or the checkpoint or start that borrows its place. Right of it is how the last ramp went. The most important value on each side sits next to the tick.',
    drops: 'Labels go, because the side tells you the topic. Board and the down/up split go. Mid-ramp the whole HUD is two lines: the speed, then the clock and the surf total either side of the tick. In full mode the clock moves above the speed, and small labels and a second detail line come back.',
    adjust: 'At a checkpoint the line is about 420 px wide, near the limit for one glance. If it feels long, I would drop the KSF speed delta in surfing mode first.'},
  {id: 'halo', cls: 'ha', name: 'Halo', render: halo,
    idea: 'Transient events appear beside the crosshair, where your eyes already are: checkpoint deltas for 6.5 s and start values for 1.8 s. Persistent values stay low with the speed.',
    drops: 'Everything near the crosshair is temporary and never holds. The lower block keeps the timer, speed and board/surf/air without labels. Full mode adds the split, sync and the full ramp row.',
    adjust: 'Very effective for a 100 ms glance, but it puts digits in the play area. I would keep the halo this small (19 px), fade it after 2.5 s rather than 6.5 s, and make it opt-in.'},
  {id: 'meter', cls: 'me', name: 'Meter', render: meter,
    idea: 'The ramp becomes a bar: air, then board, down and up in the order they happened, each coloured by its grade. The scale is set so the KSF ramp loss spans exactly the width of the speed. Match the record and the bar ends under the last digit; anything past the tick is what you lost.',
    drops: 'In surfing mode the split is a shape, not three numbers, with two values under it: the last flight\'s air loss under the air segment, and the whole ramp\'s loss (board included) under the ramp. Everything lost since the last ramp, left to right. The start borrows the checkpoint\'s spots, with sync between exit speed and height until they fade.',
    adjust: 'Bars need a reference to be meaningful. Without one I would fall back to fixed thresholds at a fixed scale (1 u/s = 3 px). Full mode repeats the numbers beneath, which is right for replays.'},
  {id: 'feed', cls: 'fd', name: 'Feed', render: feed,
    idea: 'A run log in kill-feed form. Each event is one line: the start, a landing (air and board), a ramp exit (surf), a checkpoint. The newest line sits nearest the speed and older lines step away and fade.',
    drops: 'Surfing mode keeps two lines: what just happened, and the one before it, dimmed. Every value still holds until two newer events push it out. Full mode keeps three lines with the split and the down/up detail.',
    adjust: 'Lines move as events arrive, so there is no spatial memory. That is great in replays, where order matters, and weaker mid-run. It is a strong candidate for the full HUD only.'},
  {id: 'monolith', cls: 'mo', name: 'Monolith', render: monolith,
    idea: 'Radical minimalism. The speed stands alone, slightly larger. The last ramp is a coloured rule beneath it, with the surf total centred under the rule. A checkpoint adds the PB gap as an exponent on the speed\'s shoulder and the KSF gap as a subscript.',
    drops: 'The timer, speed deltas, air, board and every label go. Full mode adds a typeset plaque on the left with the rest, set as a quiet two-column table.',
    adjust: 'The shoulder marks are the most elegant thing in the set but also the least discoverable. They need one onboarding line in the settings panel.'},
  {id: 'race', cls: 'rc', name: 'Race', render: race,
    idea: 'Checkpoint deltas as ghosts on two short tracks. You are the tick in the middle. A ghost behind you (left) means you are ahead of it, a ghost ahead means you are behind. You read the position before you read the number.',
    drops: 'The tracks take the clock\'s place for 6.5 s, without labels: KSF is the far lane and PB the near one. The ramp row keeps board, surf and air. Full mode labels the lanes and adds the split, sync and the full ramp row.',
    adjust: 'The scale (300 px per second, clamped at ±0.23 s) makes small gaps small. That is truthful, but gaps under 0.03 s look like ties. A log scale might read better.'},
  {id: 'recency', cls: 're', name: 'Recency', render: recency,
    idea: 'A typographic hierarchy by age. Slots never move, but whatever just changed is set at 30 px and settles to 15 px after about 1.5 s with one short transition. In a 100 ms glance, the biggest thing on screen is always the news.',
    drops: 'Like Axis: down/up fold into surf and the split goes. What it adds is that a settled value stops competing with a fresh one, so the ramp row recedes while the checkpoint is news.',
    adjust: 'This is the only concept that relies on motion. I would keep the settle at 200 ms ease-out and never animate size while a value is fresh.'},
];

const MIXES = [
  {name: 'Underline: Monolith with Meter\'s bar as its rule', cls: 'mo ul',
    text: 'The strongest pairing in the set. Monolith keeps the speed alone, with the checkpoint gaps on its shoulder. The rule beneath it becomes Meter\'s bar: board, down and up in order and in their grades, scaled so the KSF ramp loss spans the number exactly. A clean ramp ends under the last digit. The surf total sits under the bar, and full mode adds the plaque.',
    render: (d, full) => monolith(d, full, true)},
  {name: 'Verdict while surfing, Matrix in replays', clsFull: 'mx', clsSurf: 'vd',
    text: 'Two ends of one idea. While surfing, Verdict shows only the judgements, with the PB gap as the headline. In replays and spectating, Matrix lays the same judgements out as a scorecard: time gaps beside the timer, speed gaps beside the speed, PB on the left and KSF on the right. The contexts differ, so the change of layout costs nothing. Each is the strongest of the set at its own job.',
    render: (d, full) => full ? matrix(d, true) : verdict(d, false)},
];

/* --------------------------------------------------------------- gallery */
const params = new URLSearchParams(location.search);
const state = {
  m: MOMENTS[params.get('m')] ? params.get('m') : '2',
  bg: BACKDROPS.includes(params.get('bg')) ? params.get('bg') : 'snow',
  tint: TINTS[params.get('tint')] ? params.get('tint') : 'auto',
  size: ['true', 'tight', 'fit'].includes(params.get('size')) ? params.get('size') : innerWidth < 1880 ? 'fit' : 'true',
};
const only = params.get('only');
const sheet = params.has('sheet');

const data = () => {
  const d = MOMENTS[state.m];
  return state.tint === 'auto' ? d : {...d, energy: state.tint};
};
const frame = (cls, mode, html) => `<div class="frame"><div class="stage" style="background-image:url(../backdrops/${state.bg}.jpg)"><div class="hud ${cls} ${mode}">${html}</div></div></div>`;
const pairHtml = (c, d, captions = true) => `<div class="pair">
  <figure>${frame(c.clsFull ?? c.cls, 'full', c.render(d, true))}${captions ? `<figcaption><b>Full</b><span>replays, spectating, everything on</span></figcaption>` : '<figcaption><b>Full</b></figcaption>'}</figure>
  <figure>${frame(c.clsSurf ?? c.cls, 'surf', c.render(d, false))}${captions ? `<figcaption><b>Surfing</b><span>a glance of about 100 ms</span></figcaption>` : '<figcaption><b>Surfing</b></figcaption>'}</figure>
</div>`;

function seg(name, options, current) {
  return `<div class="seg" role="group" aria-label="${name}">${Object.entries(options).map(([value, text]) =>
    `<button type="button" data-set="${name}" data-value="${value}" aria-pressed="${value === current}">${text}</button>`).join('')}</div>`;
}

function render() {
  const d = data();
  if (sheet) {
    document.body.classList.add('sheet');
    const cell = (no, name, c, note = '') => `<div class="sh-cell"><h2><b>${no}</b>${name}${note ? `<span>${note}</span>` : ''}</h2>${pairHtml(c, d, false)}</div>`;
    document.getElementById('sheet').innerHTML = `<div class="sh-title"><h1>Surfd QoL HUD concepts</h1><span>Moment ${state.m}: ${MOMENTS[state.m].name.toLowerCase()}, ${state.bg} backdrop, true scale ×0.8. Full on the left of each pair, surfing on the right.</span></div>` +
      cell(0, 'Today', TODAY, 'the shipping HUD').replace('<b>Surfing</b>', '<b>Zen mode</b>') +
      CONCEPTS.map((c, i) => cell(i + 1, c.name, c)).join('') +
      cell('+', 'Underline', MIXES[0], 'mix of Monolith and Meter');
    document.querySelectorAll('#sheet .pair').forEach(p => p.style.setProperty('--fit', '.8'));
    return;
  }
  document.getElementById('controls').innerHTML = `
    <div class="ctl"><span>Moment</span>${seg('m', Object.fromEntries(Object.entries(MOMENTS).map(([k, m]) => [k, `${k} ${m.short}`])), state.m)}</div>
    <div class="ctl"><span>Backdrop</span>${seg('bg', Object.fromEntries(BACKDROPS.map(b => [b, b])), state.bg)}</div>
    <div class="ctl"><span>Speed tint</span>${seg('tint', TINTS, state.tint)}</div>
    <div class="ctl"><span>Size</span>${seg('size', {true: 'True scale', tight: 'Tight crop', fit: 'Fit to window'}, state.size)}</div>`;
  const m = MOMENTS[state.m];
  document.getElementById('moment').innerHTML = `<b>${state.m}. ${m.name}.</b> ${m.note}`;
  const list = only ? CONCEPTS.filter(c => c.id === only) : CONCEPTS;
  const reference = only ? '' : `<section class="concept reference" id="c-today">
      <div class="c-head"><span class="c-no">0</span><h2>Today, for reference</h2><p class="c-idea">The shipping HUD with the same data: everything on (left) and Zen mode (right), today's only reduced view. Down and air share one slot, so the flight before the ramp is not shown at this moment, and up turns grey once a flight replaces down.</p></div>
      ${pairHtml(TODAY, d).replace('<b>Surfing</b><span>a glance of about 100 ms</span>', '<b>Zen mode</b><span>speed, plus the start values</span>')}
    </section>`;
  document.getElementById('concepts').innerHTML = reference + list.map(c => {
    const n = CONCEPTS.indexOf(c) + 1;
    return `<section class="concept" id="c-${c.id}">
      <div class="c-head"><span class="c-no">${n}</span><h2>${c.name}</h2><p class="c-idea">${c.idea}</p></div>
      ${pairHtml(c, d)}
      <div class="notes"><div><h3>What surfing mode drops or merges</h3><p>${c.drops}</p></div><div><h3>What I would adjust</h3><p>${c.adjust}</p></div></div>
    </section>`;
  }).join('');
  document.getElementById('mixes').innerHTML = only ? '' : `<h2>Mixes</h2>
    <p>Parts that combine well. Same moment, backdrop and tint as above.</p>` +
    MIXES.map(x => `<div class="mix"><h3>${x.name}</h3><p>${x.text}</p>${pairHtml(x, d)}</div>`).join('');
  document.getElementById('jump').innerHTML = only ? '' : CONCEPTS.map((c, i) => `<a href="#c-${c.id}"><b>${i + 1}</b>${c.name}</a>`).join('') + '<a href="#mixes"><b>+</b>Mixes</a>';
  applyFit();
}

function applyFit() {
  document.body.classList.toggle('tight', state.size === 'tight');
  const k = state.size === 'fit' ? Math.min(1, (document.documentElement.clientWidth - 68) / 1800) : 1;
  document.querySelectorAll('.concept .pair, .mix .pair').forEach(p => p.style.setProperty('--fit', k.toFixed(3)));
}

function set(key, value) {
  state[key] = value;
  const url = new URL(location.href);
  url.searchParams.set(key, value);
  history.replaceState(null, '', url);
  render();
}

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-set]');
  if (button) set(button.dataset.set, button.dataset.value);
});
document.addEventListener('keydown', event => {
  if (event.target.closest('input, textarea') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (MOMENTS[event.key]) set('m', event.key);
  else if (event.key === 'b') set('bg', BACKDROPS[(BACKDROPS.indexOf(state.bg) + 1) % BACKDROPS.length]);
});
addEventListener('resize', applyFit);
window.HUD_MOCKS = {CONCEPTS, MOMENTS, BACKDROPS, render};
render();
})();
