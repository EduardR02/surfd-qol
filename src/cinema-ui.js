// Compare's overlay while it plays: who is who and how far apart they are at
// the top, each ghost's name above it, and the view's controls beside the
// replay bar's own tools. The bar itself stays the game's.
import {formatTime} from './hud-model.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

export const cinemaMarkup = `<section id="cinema" class="cn" aria-label="Compare" hidden>
  <div class="cn-legend">
    <span class="cn-run" data-run="0"><i aria-hidden="true"></i><b></b><span class="cn-time"></span></span>
    <span class="cn-gap" title="How far the first run is from the second at this point of the route"><b></b><small></small></span>
    <span class="cn-run" data-run="1"><i aria-hidden="true"></i><b></b><span class="cn-time"></span></span>
    <button type="button" class="cn-close" data-cn="close" aria-label="Close Compare" title="Back to the first-person replay"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
  </div>
  <span class="cn-tag" data-tag="0" hidden></span><span class="cn-tag" data-tag="1" hidden></span>
  <div class="cn-tools">
    <div class="cn-seg" role="radiogroup" aria-label="Keep the runs">
      <button type="button" role="radio" data-sync="place" title="Matched by place: the faster run is slowed so both stay together">Side by side</button>
      <button type="button" role="radio" data-sync="time" title="Matched by the clock, as a race">Real time</button>
    </div>
    <button type="button" class="cn-reset" data-cn="reset" title="Back to the planned camera (or double-click the view)">Reset view</button>
  </div>
  <p class="cn-hint">Drag to look around · Scroll to zoom · Double-click to reset</p>
</section>`;

export const cinemaStyles = `
.cn{position:fixed;inset:0;pointer-events:none;color:var(--paper);font-size:12.5px;z-index:1}
.cn-legend{position:absolute;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:4px;padding:5px 5px 5px 14px;
  border-radius:12px;background:rgba(18,18,18,.8);box-shadow:0 0 0 1px #ffffff1f,0 8px 26px rgba(0,0,0,.4);
  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);pointer-events:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
.cn-run{display:flex;align-items:center;gap:7px;min-width:0}
.cn-run i{flex:none;width:5px;height:15px;border-radius:1.5px;transform:skewX(-18deg);background:var(--run)}
.cn-run b{max-width:22ch;overflow:hidden;text-overflow:ellipsis;font-weight:700}
.cn-time{color:#a8a8a8}
.cn-gap{display:flex;flex-direction:column;align-items:center;min-width:94px;margin:0 14px;line-height:1.1}
.cn-gap b{font-size:15px;font-weight:700}
.cn-gap small{font-size:10.5px;font-weight:700;letter-spacing:.05em;color:#7a7a7a}
.cn-gap.good b{color:var(--good)}.cn-gap.loss b{color:var(--bad)}
.cn-close{display:grid;place-items:center;width:28px;height:28px;margin-left:10px;padding:0;border:0;border-radius:8px;background:none;color:#a8a8a8;cursor:pointer}
.cn-close:hover{background:rgba(255,255,255,.09);color:#eee}
.cn-close svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
.cn-tag{position:absolute;left:0;top:0;padding:2px 7px;border-radius:6px;background:rgba(14,14,14,.7);color:var(--run);font-size:11.5px;font-weight:700;
  white-space:nowrap;transform:translate(-50%,-100%);will-change:transform;box-shadow:inset 0 -2px 0 var(--run)}
.cn-tools{position:absolute;display:flex;align-items:center;gap:5px;pointer-events:auto;transition:opacity .25s}
.cn-tools.idle{opacity:0;pointer-events:none}
.cn-seg{display:flex;padding:2px;gap:2px;border-radius:9px;background:rgba(18,18,18,.88);box-shadow:inset 0 0 0 1px #ffffff30}
.cn-seg button,.cn-reset{font-family:inherit;font-weight:700;font-size:12px;color:#a8a8a8;border:0;border-radius:7px;padding:5px 10px;background:none;cursor:pointer;white-space:nowrap}
.cn-seg button:hover,.cn-reset:hover{color:var(--paper)}
.cn-seg button[aria-checked=true]{background:rgba(255,255,255,.14);color:var(--paper)}
.cn-seg button[aria-busy=true]{color:var(--paper);opacity:.6}
.cn-reset{padding:6px 10px;border:1px solid #ffffff30;border-radius:8px;background:rgba(18,18,18,.88);color:var(--paper)}
.cn-reset:hover{border-color:var(--accent)}
.cn-reset:disabled{opacity:.45;cursor:default;border-color:#ffffff30}
.cn :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cn-hint{position:absolute;left:50%;top:62px;transform:translateX(-50%);margin:0;padding:4px 10px;border-radius:8px;background:rgba(14,14,14,.6);
  color:#cfcfcf;font-size:12px;white-space:nowrap;transition:opacity .6s;opacity:0}
.cn-hint.on{opacity:1}
@media(max-width:720px){.cn-legend{gap:2px;padding-left:10px}.cn-time{display:none}.cn-gap{min-width:70px;margin:0 8px}.cn-run b{max-width:12ch}}
`;

// The played run's distance from the other at this point: behind is red,
// ahead teal, like the HUD's split deltas.
export function gapText(gap) {
  if (!Number.isFinite(gap)) return {value: '—', label: '', tone: ''};
  const behind = -gap;
  if (Math.abs(behind) < 0.0005) return {value: '0.000', label: 'level', tone: ''};
  return {value: Math.abs(behind).toFixed(3), label: behind > 0 ? 'behind' : 'ahead', tone: behind > 0 ? 'loss' : 'good'};
}

const HINT_MS = 5000;

export function createCinemaUi({root, cinema, storage = null}) {
  const section = root.getElementById('cinema');
  const runs = [...section.querySelectorAll('.cn-run')], tags = [...section.querySelectorAll('.cn-tag')];
  const gap = section.querySelector('.cn-gap'), tools = section.querySelector('.cn-tools'), hint = section.querySelector('.cn-hint');
  const reset = section.querySelector('[data-cn="reset"]'), syncs = [...section.querySelectorAll('[data-sync]')];
  let frame = 0, shown = false, drawn = '', hintTimer = 0, named = true;
  const write = (element, text) => { if (element.textContent !== text) element.textContent = text; };

  section.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.cn === 'close') cinema.close();
    else if (button.dataset.cn === 'reset') cinema.resetView();
    else if (button.dataset.sync) void cinema.setSync(button.dataset.sync);
  });

  // Names follow the ghosts every frame, and only while Compare plays.
  function follow() {
    frame = 0;
    const status = shown ? cinema.status() : null;
    if (!status || status.phase !== 'playing') return;
    for (const [index, tag] of tags.entries()) {
      const at = named ? status.labels?.[index] : null;
      if (tag.hidden !== !at) tag.hidden = !at;
      if (at) tag.style.transform = `translate(${at.x.toFixed(1)}px,${(at.y - 6).toFixed(1)}px) translate(-50%,-100%)`;
    }
    const text = gapText(status.gap);
    write(gap.firstElementChild, text.value);
    write(gap.lastElementChild, text.label);
    const tone = `cn-gap${text.tone ? ` ${text.tone}` : ''}`;
    if (gap.className !== tone) gap.className = tone;
    frame = requestAnimationFrame(follow);
  }

  function showHint() {
    let seen = false;
    try { seen = storage?.getItem('surfd-qol.compare-hint') === '1'; } catch { /* shown again */ }
    if (seen) return;
    hint.classList.add('on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.classList.remove('on'); try { storage?.setItem('surfd-qol.compare-hint', '1'); } catch { /* shown again */ } }, HINT_MS);
  }
  function hide() {
    if (!shown) return;
    shown = false;
    section.hidden = true;
    cancelAnimationFrame(frame); frame = 0;
    clearTimeout(hintTimer); hint.classList.remove('on');
    drawn = '';
  }

  return {
    // anchor: the replay tools' rect, beside which the controls sit; idle: the bar has faded out.
    // tags: whether names may follow the ghosts (not over the game's finish card).
    render({visible, anchor = null, custom = false, idle = false, tags: showTags = true}) {
      const status = visible ? cinema.status() : null;
      if (!status || status.phase !== 'playing') { hide(); return; }
      if (!shown) { shown = true; section.hidden = false; showHint(); }
      const key = JSON.stringify([status.runs.map(run => [run.label, run.time, run.color]), status.sync, status.pending, status.adjusted]);
      if (key !== drawn) {
        drawn = key;
        for (const [index, run] of status.runs.entries()) {
          runs[index].style.setProperty('--run', run.color);
          tags[index].style.setProperty('--run', run.color);
          write(runs[index].children[1], run.label);
          write(runs[index].children[2], Number.isFinite(run.time) ? formatTime(run.time) : '');
          write(tags[index], run.label);
        }
        for (const button of syncs) {
          button.setAttribute('aria-checked', String(status.sync === button.dataset.sync));
          button.toggleAttribute('aria-busy', status.pending === button.dataset.sync);
        }
        reset.disabled = !status.adjusted;
      }
      if (anchor) {
        tools.style.bottom = `${Math.round(innerHeight - anchor.bottom)}px`;
        tools.style.right = custom ? '20px' : `${Math.round(innerWidth - anchor.left + 5)}px`;
        if (custom) tools.style.bottom = `${Math.round(innerHeight - anchor.top + 8)}px`;
      }
      tools.classList.toggle('idle', idle);
      named = showTags;
      if (!frame) frame = requestAnimationFrame(follow);
    },
    hide,
    destroy() { hide(); },
  };
}
