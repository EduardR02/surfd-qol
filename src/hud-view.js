// In-run HUD: markup and a renderer for the hud-model view model.
// Geometry: the .hud element is a zero-size anchor at the speed number's
// centre. Every row is positioned from that point on its own, so the speed
// stays on the viewport centreline whatever the other rows contain.
import {fontFaces} from './hud-fonts.js';

export const FONT_FAMILY = 'Surfd QoL Sans';

// Chrome ignores @font-face inside shadow roots, so faces are registered on
// the document. Bundled data only: no network requests.
export function installFonts() {
  if (typeof FontFace !== 'function' || !document.fonts) return () => {};
  const faces = [];
  for (const {weight, style, data} of fontFaces) {
    try {
      const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
      const face = new FontFace(FONT_FAMILY, bytes, {weight, style, display: 'swap'});
      document.fonts.add(face);
      face.load().catch(() => {});
      faces.push(face);
    } catch { /* fall back to system fonts */ }
  }
  return () => { for (const face of faces) document.fonts.delete(face); };
}

// Numbers are split into a whole part and a smaller fraction: the eye lands
// on "−14" or "01:12" first, and the fastest-changing digits stay quiet.
const num = (key, className, initial = '—') => `<b class="${className}" data-num="${key}"><span>${initial}</span><span class="f"></span></b>`;
const label = (key, initial) => `<span class="lab" data-text="${key}">${initial}</span>`;

export const hudMarkup = `
  <div class="events">
    <div class="split" data-part="checkpoint" hidden>
      <div class="split-head"><span class="cp" data-text="cp"></span>${num('splitTime', 'split-time')}<b class="split-speed" data-text="splitSpeed"></b></div>
      <div class="refs">
        <div class="ref" data-part="pb"><span class="pair"><b class="dt" data-text="pbTime"></b><b class="ds" data-text="pbSpeed"></b></span>${label('pbLabel', 'PB')}</div>
        <div class="ref" data-part="wr"><span class="pair"><b class="dt" data-text="wrTime"></b><b class="ds" data-text="wrSpeed"></b></span>${label('wrLabel', 'KSF')}</div>
      </div>
    </div>
    <div class="start" data-part="start" hidden>
      <div class="cell"><b class="val" data-text="startSpeed"></b>${label('startSpeedLabel', 'start')}</div>
      <b class="start-sync" data-text="startSync" hidden></b>
      <div class="cell">${num('startHeight', 'val')}${label('startHeightLabel', 'height')}</div>
    </div>
  </div>
  <div class="clock" data-part="clock">
    <span class="sync" data-text="sync"></span>
    ${num('time', 'time')}
    <span class="state" data-text="state"></span>
  </div>
  <div class="speed" data-part="speed" data-text="speed">—</div>
  <div class="feedback" data-part="feedback">
    <div class="slot" data-part="board">${num('board', 'val')}${label('boardLabel', 'board')}</div>
    <div class="slot" data-part="result">${num('result', 'val')}${label('resultLabel', 'air')}</div>
    <div class="slot" data-part="up">${num('up', 'val')}${label('upLabel', 'up')}</div>
  </div>
  <div class="meter" data-part="meter" hidden>
    <i class="m-track" data-part="segTrack"></i><i class="m-seg" data-part="segAir"></i><i class="m-seg" data-part="segBoard"></i><i class="m-seg" data-part="segDown"></i><i class="m-seg" data-part="segUp"></i><i class="m-tick" data-part="segTick"></i>
    ${num('meterAir', 'm-value')}${num('meterRamp', 'm-value')}
    <div class="m-row" data-part="rampRow">${['air', 'board', 'down', 'up', 'surf'].map(name =>
      `<div class="slot" data-part="${name}Slot">${num(`${name}Value`, 'val')}<span class="lab">${name}</span></div>`).join('')}</div>
  </div>`;

// A new ramp's board alone never fills less of the bar than this many u/s would.
const MIN_SPAN = 50;
// The meter bar in px from the speed's centre. It always has the same width,
// centred under the speed: the last flight, then the ramp, share it in
// proportion, and the tick marks where the ramp would have ended had it cost
// what the reference ramp did. When you beat the reference, a track fills
// the rest up to the tick at the end. Pure, so it is tested without a DOM.
//
// Losses can be negative (a booster, a push, a gain in the air): a gain takes
// no room, and the bar spans exactly what it draws, so nothing runs past it.
export function meterLayout(meter, full) {
  const width = full ? 260 : 172, x0 = -width / 2, gap = 2;
  const {board, down, up, surf, air} = meter;
  const room = item => Number.isFinite(item?.value) && item.value > 0 ? item.value : 0;
  const flight = room(air);
  // Where each part of the ramp ends, from the flight's end. DOWN and SURF
  // include the board, so they never end before it.
  const boardEnd = room(board);
  const ends = meter.fresh ? [['board', boardEnd, board]]
    : meter.split && down && up ? [['board', boardEnd, board], ['down', Math.max(boardEnd, room(down)), down], ['up', Math.max(boardEnd, room(down)) + room(up), up]]
    : surf ? [['board', boardEnd, board], ['down', Math.max(boardEnd, room(surf)), surf]]
    : [['board', boardEnd, board]];
  // A new ramp has cost only its board so far; a finished one, its whole loss.
  const ramp = ends.at(-1)[1];
  const reference = !meter.fresh && Number.isFinite(meter.reference) && meter.reference > 0 ? meter.reference : null;
  const span = Math.max(flight + ramp, reference !== null ? flight + reference : 0, meter.fresh ? MIN_SPAN : 0) || 1;
  const at = value => x0 + Math.min(1, value / span) * width;
  const segments = {};
  const piece = (part, from, to, item, last) => {
    if (!item || !(to > from)) return;
    segments[part] = {left: at(from), width: Math.max(2, at(to) - at(from) - (last ? 0 : gap)), tone: item.tone};
  };
  // The flight, a wider gap, then the ramp in the order it happened.
  piece('air', 0, flight, air, false);
  if (segments.air) segments.air.width = Math.max(2, segments.air.width - gap);
  let from = flight;
  ends.forEach(([part, end, item], index) => {
    piece(part, from, flight + end, item, index === ends.length - 1);
    from = Math.max(from, flight + end);
  });
  // The two values stay put: the flight's under the left half, the ramp's under the right.
  const both = !!air && !!(meter.ramp ?? board);
  return {segments, width, left: x0, tick: reference !== null ? Math.min(at(flight + reference), x0 + width) - 1 : null,
    airCenter: air ? (both ? -width * 0.3 : 0) : null, rampCenter: both ? width * 0.3 : 0};
}

const TONES = new Set(['good', 'warn', 'loss', 'muted']);
const tone = value => TONES.has(value) ? value : 'muted';

// Renders into an element that already contains hudMarkup. Every write is
// skipped when unchanged, so a 67 ms render of an idle HUD touches nothing.
export function createHudView(element) {
  const collect = attribute => Object.fromEntries([...element.querySelectorAll(`[data-${attribute}]`)].map(node => [node.dataset[attribute], node]));
  const parts = collect('part'), texts = collect('text'), nums = collect('num');
  const write = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const text = (key, value) => write(texts[key], value);
  const number = (key, value) => {
    const cut = value.lastIndexOf('.');
    const [whole, fraction] = nums[key].children;
    write(whole, cut > 0 ? value.slice(0, cut) : value);
    write(fraction, cut > 0 ? value.slice(cut) : '');
  };
  const hide = (node, hidden) => { if (node.hidden !== hidden) node.hidden = hidden; };
  const place = (node, style) => { if (node.getAttribute('style') !== style) node.setAttribute('style', style); };
  const cls = (node, value) => { if (node.className !== value) node.className = value; };
  const title = (node, value = '') => { if (node.title !== value) node.title = value; };
  let energy = 'neutral';

  function slot(key, model) {
    hide(parts[key], model.hidden);
    if (model.hidden) return;
    number(key, model.text);
    text(`${key}Label`, String(model.label).toLowerCase());
    cls(nums[key], `val ${tone(model.tone)}`);
    cls(parts[key], model.stale ? 'slot stale' : 'slot');
    title(parts[key], model.title);
  }
  function reference(key, model) {
    hide(parts[key], model.hidden);
    if (model.hidden) return;
    text(`${key}Label`, model.label);
    text(`${key}Time`, model.time.text);
    text(`${key}Speed`, model.speed.text);
    // No reference at all reads as one dash, not two.
    hide(texts[`${key}Speed`], model.time.text === '—' && model.speed.text === '—');
    cls(texts[`${key}Time`], `dt ${tone(model.time.tone)}`);
    cls(texts[`${key}Speed`], `ds ${tone(model.speed.tone)}`);
    title(parts[key], model.speed.title);
  }

  function meter(model, layout) {
    hide(parts.meter, model.hidden !== false);
    if (model.hidden !== false) return;
    const full = layout === 'full', geometry = meterLayout(model, full);
    for (const [part, name] of [['segAir', 'air'], ['segBoard', 'board'], ['segDown', 'down'], ['segUp', 'up']]) {
      const segment = geometry.segments[name];
      hide(parts[part], !segment);
      if (!segment) continue;
      place(parts[part], `left:${segment.left.toFixed(1)}px;width:${segment.width.toFixed(1)}px`);
      cls(parts[part], `m-seg ${tone(segment.tone)}`);
    }
    place(parts.segTrack, `left:${geometry.left.toFixed(1)}px;width:${geometry.width}px`);
    hide(parts.segTick, geometry.tick === null);
    if (geometry.tick !== null) place(parts.segTick, `left:${geometry.tick.toFixed(1)}px`);
    // Surfing: two values under the bar. Full: every value in a row.
    const under = (key, center, item) => {
      hide(nums[key], full || !item || center === null);
      if (full || !item || center === null) return;
      number(key, item.text);
      cls(nums[key], `m-value ${tone(item.tone)}${item.stale ? ' stale' : ''}`);
      place(nums[key], `left:${center.toFixed(1)}px`);
    };
    under('meterAir', geometry.airCenter, model.air);
    under('meterRamp', geometry.rampCenter, model.ramp);
    hide(parts.rampRow, !full);
    if (!full) return;
    const shown = {air: model.air, board: model.board, down: model.split ? model.down : null, up: model.split ? model.up : null, surf: model.surf};
    for (const [name, item] of Object.entries(shown)) {
      hide(parts[`${name}Slot`], !item);
      if (!item) continue;
      number(`${name}Value`, item.text);
      cls(nums[`${name}Value`], `val ${tone(item.tone)}`);
      cls(parts[`${name}Slot`], item.stale ? 'slot stale' : 'slot');
    }
  }

  return {
    setSpeed(value) { text('speed', value); },
    setTime(value) { number('time', value); },
    setEnergy(next) {
      if (next === energy) return;
      energy = next;
      cls(parts.speed, next === 'good' || next === 'loss' ? `speed e-${next}` : 'speed');
    },
    render(model) {
      const layout = model.layout ?? 'full';
      element.classList.toggle('zen', model.zen === true);
      element.classList.toggle('full', layout === 'full');
      element.classList.toggle('surf', layout === 'surf');
      hide(parts.clock, model.clock?.hidden === true);
      hide(nums.time, model.time?.hidden === true);
      text('sync', model.sync.hidden ? '' : model.sync.text);
      cls(texts.sync, `sync ${tone(model.sync.tone)}`);
      hide(texts.sync, model.sync.hidden);
      text('state', model.runState.text);
      title(texts.state, model.runState.title);

      hide(parts.feedback, model.feedback.hidden);
      if (!model.feedback.hidden) {
        slot('board', model.feedback.board);
        slot('result', model.feedback.result);
        slot('up', model.feedback.up);
      }

      const start = model.start;
      hide(parts.start, start.hidden);
      if (!start.hidden) {
        text('startSpeed', start.speed.text);
        number('startHeight', start.height.text);
        cls(texts.startSpeed, `val ${tone(start.speed.tone)}`);
        cls(nums.startHeight, `val ${tone(start.height.tone)}`);
        title(parts.start, start.title);
        const sync = model.startSync ?? {hidden: true};
        hide(texts.startSync, sync.hidden !== false);
        if (sync.hidden === false) { text('startSync', sync.text); cls(texts.startSync, `start-sync ${tone(sync.tone)}`); }
      }
      meter(model.meter ?? {hidden: true}, layout);

      const checkpoint = model.checkpoint;
      hide(parts.checkpoint, checkpoint.hidden);
      if (!checkpoint.hidden) {
        text('cp', checkpoint.label);
        // Spectating has no split time or speed; show only the progress.
        number('splitTime', checkpoint.time);
        text('splitSpeed', checkpoint.speed);
        hide(nums.splitTime, checkpoint.time === '—');
        hide(texts.splitSpeed, checkpoint.speed === '—');
        reference('pb', checkpoint.pb);
        reference('wr', checkpoint.wr);
      }
    },
  };
}
