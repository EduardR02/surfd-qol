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
  </div>`;

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

  return {
    setSpeed(value) { text('speed', value); },
    setTime(value) { number('time', value); },
    setEnergy(next) {
      if (next === energy) return;
      energy = next;
      cls(parts.speed, next === 'good' || next === 'loss' ? `speed e-${next}` : 'speed');
    },
    render(model) {
      element.classList.toggle('zen', model.zen === true);
      hide(parts.clock, model.clock?.hidden === true);
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
      }

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
