// Settings panel: markup, live preview and control binding. Opened only from
// menus; every change is saved through onSettings immediately.
import {hudMarkup, createHudView} from './hud-view.js';

const swatch = tone => `<i class="sw ${tone}" aria-hidden="true"></i>`;
const hint = text => text ? `<span class="hint">${text}</span>` : '';
const text = (label, help, id = '') => `<span class="row-text"><span class="row-label"${id ? ` id="${id}"` : ''}>${label}</span>${hint(help)}</span>`;
const toggle = (key, label, help = '', extra = '') =>
  `<label class="row${extra}">${text(label, help)}<input class="switch" type="checkbox" data-setting="${key}"></label>`;
const choice = (key, label, options, help = '', extra = '') =>
  `<div class="row${extra}" role="radiogroup" aria-labelledby="label-${key}" data-group="${key}">${text(label, help, `label-${key}`)}<span class="seg">${
    options.map(([value, name]) => `<label><input type="radio" name="qol-${key}" value="${value}" data-setting="${key}"><span>${name}</span></label>`).join('')
  }</span></div>`;
const range = (key, label, min, max, step, help = '') =>
  `<label class="row">${text(label, help)}<span class="range"><input type="range" min="${min}" max="${max}" step="${step}" data-setting="${key}"><output data-output="${key}"></output></span></label>`;
const number = (key, label, min, max, step, unit, help = '', extra = '') =>
  `<label class="row${extra}">${text(label, help)}<span class="num"><input type="number" min="${min}"${max ? ` max="${max}"` : ''} step="${step}" data-setting="${key}"><span class="unit">${unit}</span></span></label>`;
const cutoff = (key, label, step, unit) =>
  `<input type="number" min="0" step="${step}" data-setting="${key}" aria-label="${label}"><span class="unit">${unit}</span>`;
const color = (key, label) =>
  `<label class="color"><input type="color" data-setting="${key}"><span>${label}</span></label>`;
const references = [['fixed', 'Fixed'], ['pb', 'PB'], ['wr', 'WR']];

export const launcherMarkup = `<button id="open" class="launcher" type="button" aria-expanded="false" aria-controls="panel" hidden><span class="mark" aria-hidden="true"></span>QoL</button>`;

export const panelMarkup = `
<section id="panel" role="dialog" aria-labelledby="panel-title" hidden>
  <header class="head">
    <h2 id="panel-title"><span class="mark" aria-hidden="true"></span>Surfd QoL</h2>
    <span class="saved">Changes save automatically</span>
    <button id="close" class="close" type="button" aria-label="Close settings"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
  </header>
  <div class="preview" aria-hidden="true">
    <svg class="scene" viewBox="0 0 560 160" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="pv-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2430"/><stop offset=".55" stop-color="#4a566a"/><stop offset="1" stop-color="#b8a09c"/></linearGradient>
        <radialGradient id="pv-glow" cx=".8" cy=".12" r=".45"><stop offset="0" stop-color="#ffd9c8" stop-opacity=".55"/><stop offset="1" stop-color="#ffd9c8" stop-opacity="0"/></radialGradient>
        <linearGradient id="pv-lit" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#cfd1d6"/><stop offset=".6" stop-color="#9097a0"/><stop offset="1" stop-color="#5d646d"/></linearGradient>
        <linearGradient id="pv-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4c5560"/><stop offset="1" stop-color="#262c33"/></linearGradient>
      </defs>
      <rect width="560" height="160" fill="url(#pv-sky)"/><rect width="560" height="160" fill="url(#pv-glow)"/>
      <path d="M0 118 L70 104 L132 112 L214 96 L290 109 L362 100 L440 111 L512 99 L560 106 V160 H0Z" fill="#2a323d"/>
      <path d="M-30 160 L118 42 L470 124 L420 160Z" fill="url(#pv-lit)"/>
      <path d="M420 160 L470 124 L500 122 L560 142 V160Z" fill="url(#pv-shade)"/>
    </svg>
    <div class="hud preview-hud">${hudMarkup}</div>
  </div>
  <nav class="tabs" role="tablist" aria-label="Settings sections">
    <button id="tab-display" type="button" role="tab" aria-selected="true" aria-controls="page-display" data-page="display">Display</button>
    <button id="tab-feedback" type="button" role="tab" aria-selected="false" aria-controls="page-feedback" data-page="feedback" tabindex="-1">Feedback</button>
    <button id="tab-compare" type="button" role="tab" aria-selected="false" aria-controls="page-compare" data-page="compare" tabindex="-1">Compare</button>
    <button id="tab-controls" type="button" role="tab" aria-selected="false" aria-controls="page-controls" data-page="controls" tabindex="-1">Controls</button>
    <button id="tab-history" type="button" role="tab" aria-selected="false" aria-controls="page-history" data-page="history" tabindex="-1">History</button>
  </nav>
  <div class="body">
    <section id="page-display" role="tabpanel" aria-labelledby="tab-display" tabindex="0">
      <div class="group">
        ${toggle('hud', 'Custom HUD', 'Off brings back the game’s own speed and timer.')}
      </div>
      <h3>Layout</h3>
      <div class="group">
        ${range('y', 'Height on screen', 10, 90, 1)}
        ${range('scale', 'Size', 0.6, 1.6, 0.05)}
        ${range('opacity', 'Opacity', 0.25, 1, 0.05)}
        <div class="actions"><span class="note">Always centered horizontally.</span><button id="reset-layout" class="ghost" type="button">Reset layout</button></div>
      </div>
      <h3>Colors</h3>
      <div class="group">
        <div class="colors">
          ${color('speedColor', 'Speed')}
          ${color('goodColor', 'Better')}
          ${color('warnColor', 'Near')}
          ${color('badColor', 'Worse')}
        </div>
        <div class="actions"><span class="note">Unavailable values stay gray.</span><button id="reset-colors" class="ghost" type="button">Reset colors</button></div>
      </div>
      <h3>Refresh rate</h3>
      <div class="group">
        ${number('speedFps', 'Speed', 1, 1000, 1, 'fps')}
        ${number('timerFps', 'Timer', 1, 1000, 1, 'fps', 'Counters only. The game itself is not affected.')}
      </div>
    </section>

    <section id="page-feedback" role="tabpanel" aria-labelledby="tab-feedback" tabindex="0" hidden>
      <h3>Values</h3>
      <div class="group">
        ${toggle('showBoard', 'Board', 'Speed lost as you land on a ramp.')}
        ${toggle('showSurf', 'Ramp', 'Speed lost on the last ramp, after height is accounted for.')}
        ${choice('rampResult', 'Show as', [['split', 'Down + Up'], ['total', 'Net Surf']], 'Split into the way down and the way up, or one net value.', ' sub')}
        ${toggle('showAir', 'Air', 'Speed lost over your last flight.')}
        ${choice('airMetric', 'Count', [['missed', 'Missed gain'], ['braking', 'Braking'], ['combined', 'Both']], '<span id="air-explain"></span>', ' sub')}
        ${toggle('showSync', 'Strafe sync')}
        ${toggle('showStart', 'Start speed and height', 'Shown for a moment as you leave the start.')}
      </div>
      <h3>Live mode</h3>
      <div class="group">
        ${toggle('continuousFeedback', 'Live feedback', 'Values update continuously instead of holding each result.')}
        ${range('strafeLookbackSeconds', 'Live window', 0.05, 0.5, 0.05, 'How much recent movement each live value covers.')}
      </div>
      <h3>Speed tint <span class="tag">Experimental</span></h3>
      <div class="group">
        ${toggle('speedEnergyColor', 'Tint speed by energy', `${swatch('good')}while you gain units, ${swatch('loss')}while you lose them. Height changes don’t count.`)}
        ${toggle('speedEnergyRamps', 'Include ramps', `Ramp surfing always bleeds some energy, so this is mostly ${swatch('loss')}.`, ' sub')}
      </div>
    </section>

    <section id="page-compare" role="tabpanel" aria-labelledby="tab-compare" tabindex="0" hidden>
      <h3>Checkpoints</h3>
      <div class="group">
        ${choice('checkpointReference', 'Compare with', [['pb', 'PB'], ['wr', 'WR'], ['both', 'Both']])}
        ${choice('wrSource', 'World record', [['ksf', 'KSF route'], ['leaderboard', 'Surfd #1']], 'KSF is the map’s record route; Surfd #1 is the leaderboard’s top run. Also used for WR colors.')}
      </div>
      <h3>Grade colors against</h3>
      <div class="group">
        ${choice('boardColorReference', 'Board', references)}
        ${choice('surfColorReference', 'Ramp', references, 'Down, Up and Surf.')}
        ${choice('startColorReference', 'Start', references)}
        ${number('referenceLossTolerance', 'Near margin', 0, 0, 0.1, 'u/s', 'How much worse than PB or WR still counts as near. Start has no near band.')}
        <div class="legend" aria-label="Color key">
          <span>${swatch('good')}Equal or better</span><span>${swatch('warn')}Within the margin</span><span>${swatch('loss')}Worse</span><span>${swatch('muted')}No data</span>
        </div>
      </div>
      <details class="group">
        <summary><span class="row-label">Fixed cutoffs</span><span class="hint">Used for Air, and wherever Fixed is picked above.</span></summary>
        <div class="cutoffs" role="table" aria-label="Fixed cutoffs">
          <span role="columnheader"></span><span role="columnheader">${swatch('good')}below</span><span role="columnheader">${swatch('warn')}below</span>
          <span role="rowheader">Start height</span><span class="num">${cutoff('startHeightAmazing', 'Start height, better below', 0.1, 'u')}</span><span class="num">${cutoff('startHeightGood', 'Start height, near below', 0.1, 'u')}</span>
          <span role="rowheader">Start speed short of cap</span><span class="num">${cutoff('startDeficitAmazing', 'Start speed shortfall, better below', 0.1, 'u/s')}</span><span class="num">${cutoff('startDeficitGood', 'Start speed shortfall, near below', 0.1, 'u/s')}</span>
          <span role="rowheader">Board loss</span><span class="num">${cutoff('boardLossAmazing', 'Board loss, better below', 0.5, 'u/s')}</span><span class="num">${cutoff('boardLossGood', 'Board loss, near below', 0.5, 'u/s')}</span>
          <span role="rowheader">Air and ramp loss</span><span class="num">${cutoff('airLossAmazing', 'Air and ramp loss, better below', 0.5, 'u/s')}</span><span class="num">${cutoff('airLossGood', 'Air and ramp loss, near below', 0.5, 'u/s')}</span>
        </div>
        <p class="explain">Anything else is ${swatch('loss')}worse. Sync uses the game’s own steps: ${swatch('good')}95% ${swatch('warn')}85% ${swatch('loss')}below.</p>
      </details>
    </section>

    <section id="page-controls" role="tabpanel" aria-labelledby="tab-controls" tabindex="0" hidden>
      <h3>Crouch-jump</h3>
      <div class="group">
        ${toggle('crouchJump', 'Crouch-jump', 'Adds a one-tick crouch to every jump.')}
        <div class="row"><span class="row-text"><span class="row-label" id="key-label">Jump key</span><span class="hint" id="key-help" role="status"></span></span><button id="key" class="keycap" type="button" aria-labelledby="key-label key" aria-describedby="key-help"></button></div>
      </div>
      <h3>Null binds</h3>
      <div class="group">
        ${toggle('nullAD', 'Left / Right', 'Uses your movement bindings in Surfd’s settings.')}
        ${toggle('nullWSpace', 'Forward / Jump', 'Uses your bindings, including extra keys. Latest press wins; release it to resume the other action.')}
      </div>
    </section>

    <section id="page-history" role="tabpanel" aria-labelledby="tab-history" tabindex="0" hidden>
      <div class="group">
        ${toggle('keepHistory', 'Record runs', 'Keeps your attempts on each map for the Runs panel.')}
        ${number('historyRunsPerMap', 'Runs kept per map', 3, 100, 1, 'runs', '', ' sub')}
        ${number('historyMinSeconds', 'Skip short resets', 0, 300, 1, 's', '', ' sub')}
        ${toggle('saveReplays', 'Save replays', '<span id="replay-size">So you can rewatch your runs.</span>', ' sub')}
      </div>
      <p id="history-rule" class="hist-rule" role="status"></p>
      <h3>Storage</h3>
      <div class="group hist-store">
        <div class="hist-total"><b id="size-total"></b><span id="size-where">in this browser only</span></div>
        <div id="size-bar" class="hist-bar" aria-hidden="true"></div>
        <dl class="hist-keys">
          <dt class="replays">Replays</dt><dd id="usage-replays"></dd><dd class="size" id="size-replays"></dd>
          <dt class="runs">Runs and bests</dt><dd id="usage-runs"></dd><dd class="size" id="size-runs"></dd>
        </dl>
        <div class="actions clear-row"><span class="note" id="clear-note" role="status"></span>
          <span class="clear-buttons"><button id="clear-cancel" class="ghost" type="button" hidden>Cancel</button><button id="clear-history" class="ghost" type="button">Clear all</button></span></div>
      </div>
    </section>
  </div>
  <p id="status" class="status" role="status"></p>
</section>`;

const AIR_EXPLAIN = {
  missed: 'Speed a better strafe could have added. Chasing every gain can lengthen your line.',
  braking: 'Speed your own input took away. Tight turns can need some.',
  combined: 'Missed gain plus braking. Tight turns can need some braking.',
};
const KEY_HELP = 'Click, then press the new key. Esc cancels.';

// A fixed, illustrative HUD for the preview: it follows the palette and the
// feedback options, never real measurements.
export function previewModel(settings) {
  const live = settings.continuousFeedback === true;
  const split = settings.rampResult !== 'total';
  const ramp = settings.showSurf !== false, air = settings.showAir !== false;
  const value = (hidden, label, text, tone) => ({hidden, label, text, tone, title: '', stale: false});
  const result = live
    ? value(!air && !ramp, air ? 'STRAFE' : 'INPUT', '−0.4', 'good')
    : ramp ? value(false, split ? 'DOWN' : 'SURF', split ? '−14.6' : '−52.7', 'warn')
      : value(!air, settings.airMetric === 'missed' ? 'MISSED' : settings.airMetric === 'braking' ? 'BRAKE' : 'AIR', '−9.8', 'warn');
  const board = value(settings.showBoard === false, 'BOARD', '−3.2', 'good');
  const up = value(live || !ramp || !split, 'UP', '−38.1', 'loss');
  return {
    sync: {hidden: settings.showSync === false, text: '96.4%', tone: 'good'},
    runState: {text: '', title: ''},
    feedback: {hidden: result.hidden && board.hidden && up.hidden, result, board, up},
    start: {hidden: true},
    checkpoint: {hidden: true},
  };
}

// Sizes for the Storage row: KB below a megabyte, then MB.
export function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(bytes ? 1 : 0, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
// What the History settings keep, said as one plain sentence (HTML).
export function historyRule(settings) {
  if (settings.keepHistory === false) return 'Recording is off. Nothing new is added, and what you already have stays until you clear it.';
  const runs = settings.historyRunsPerMap, short = settings.historyMinSeconds;
  return `On each map you keep <b>your PB</b>, <b>your latest attempt</b> and <b>your ${runs} newest runs</b>${
    short > 0 ? `, not counting resets under ${short} s` : ''}. Your best splits and ramps stay even after the runs that set them are gone.`;
}

export function createSettingsPanel({root, settings, onSettings, onResetColors, onResetLayout, bindings, host, onChange, onOpen, storage}) {
  const node = id => root.getElementById(id);
  const panel = node('panel'), opener = node('open'), close = node('close'), keyButton = node('key'), keyHelp = node('key-help');
  const body = panel.querySelector('.body');
  const tabs = [...panel.querySelectorAll('[role="tab"]')];
  const controls = [...panel.querySelectorAll('[data-setting]')];
  const outputs = Object.fromEntries([...panel.querySelectorAll('[data-output]')].map(output => [output.dataset.output, output]));
  const previewElement = panel.querySelector('.preview-hud');
  const preview = createHudView(previewElement);
  let capturing = false, available = false;
  const write = (element, value) => { if (element.textContent !== value) element.textContent = value; };

  function format(key, value) {
    if (key === 'strafeLookbackSeconds') return `${value.toFixed(2)} s`;
    if (key === 'y' || key === 'scale' || key === 'opacity') return `${Math.round(value * (key === 'y' ? 1 : 100))}%`;
    return String(value);
  }
  function sync() {
    for (const control of controls) {
      const key = control.dataset.setting, value = settings[key];
      if (control.type === 'checkbox') control.checked = value !== false;
      else if (control.type === 'radio') control.checked = value === control.value;
      else control.value = value;
      if (control.type === 'range') {
        const min = Number(control.min), max = Number(control.max);
        control.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
      }
      if (outputs[key]) write(outputs[key], format(key, value));
    }
    const live = settings.continuousFeedback === true;
    setDisabled('strafeLookbackSeconds', !live);
    setDisabled('speedEnergyRamps', settings.speedEnergyColor !== true);
    setDisabled('rampResult', live || settings.showSurf === false);
    setDisabled('airMetric', live || settings.showAir === false);
    const recording = settings.keepHistory !== false;
    setDisabled('historyRunsPerMap', !recording);
    setDisabled('historyMinSeconds', !recording);
    setDisabled('saveReplays', !recording);
    showUsage();
    write(node('air-explain'), AIR_EXPLAIN[settings.airMetric] ?? AIR_EXPLAIN.combined);
    if (!capturing) write(keyButton, keyName(settings.crouchJumpKey));
    panel.style.setProperty('--opacity', settings.opacity);
    previewElement.classList.toggle('energy', settings.speedEnergyColor === true);
    preview.setSpeed('2950');
    preview.setTime('00:41.233');
    preview.render(previewModel(settings));
  }
  // Storage: what history and replays take in this browser, and Clear all,
  // which asks once before deleting.
  let clearState = 'idle';
  const clearButton = node('clear-history'), cancelButton = node('clear-cancel');
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  let ruleShown = '', barShown = '';
  function showUsage() {
    let usage = null;
    try { usage = storage?.usage(); } catch { /* unavailable */ }
    const runs = usage?.history, saved = usage?.replays;
    write(node('usage-runs'), runs ? (runs.runs || runs.maps ? `${plural(runs.runs, 'run')} on ${plural(runs.maps, 'map')}` : 'None yet') : 'Unavailable');
    write(node('size-runs'), runs ? formatBytes(runs.bytes) : '');
    write(node('usage-replays'), saved ? (saved.count ? plural(saved.count, 'replay') : 'None yet') : 'Unavailable');
    write(node('size-replays'), saved ? formatBytes(saved.bytes) : '');
    const runBytes = runs?.bytes ?? 0, replayBytes = saved?.bytes ?? 0, all = runBytes + replayBytes;
    write(node('size-total'), formatBytes(all));
    write(node('replay-size'), saved?.count ? `So you can rewatch your runs. About ${formatBytes(replayBytes / saved.count)} each so far.` : 'So you can rewatch your runs.');
    // The bar splits what's stored between replays and runs; it has no capacity to fill.
    const bar = all ? `<i class="replays" style="flex:${replayBytes}"></i><i class="runs" style="flex:${runBytes}"></i>` : '<i class="none"></i>';
    if (bar !== barShown) { barShown = bar; node('size-bar').innerHTML = bar; }
    const rule = historyRule(settings);
    if (rule !== ruleShown) { ruleShown = rule; node('history-rule').innerHTML = rule; }
    node('history-rule').classList.toggle('off', settings.keepHistory === false);
    const empty = !runs?.runs && !runs?.maps && !saved?.count;
    clearButton.hidden = !storage;
    const asking = clearState === 'confirm' || clearState === 'clearing';
    clearButton.disabled = clearState === 'clearing' || (!asking && empty);
    cancelButton.hidden = clearState !== 'confirm';
    write(clearButton, clearState === 'clearing' ? 'Clearing…' : 'Clear all');
    clearButton.classList.toggle('danger', asking);
    write(node('clear-note'), clearState === 'confirm' ? 'Clear every run, best and replay on every map? This can’t be undone.'
      : clearState === 'done' ? 'Cleared.' : '');
    node('clear-note').classList.toggle('warn', clearState === 'confirm');
  }
  function setClear(next) { clearState = next; showUsage(); }
  clearButton.addEventListener('click', () => {
    if (clearState === 'idle' || clearState === 'done') { setClear('confirm'); cancelButton.focus(); return; }
    if (clearState !== 'confirm') return;
    setClear('clearing');
    Promise.resolve(storage?.clear()).catch(() => {}).then(() => { setClear('done'); clearButton.focus(); });
  });
  cancelButton.addEventListener('click', () => { setClear('idle'); clearButton.focus(); });
  function setDisabled(key, disabled) {
    for (const control of controls) {
      if (control.dataset.setting !== key) continue;
      control.disabled = disabled;
      control.closest('.row')?.classList.toggle('off', disabled);
    }
  }
  function keyName(code) {
    const value = code || 'Space';
    return value.replace(/^Key(?=[A-Z]$)/, '').replace(/^Digit(?=\d$)/, '').replace(/^Arrow/, '').replace(/(Left|Right)$/, ' $1');
  }
  function patch(value) {
    onSettings(value);
    sync();
    onChange?.();
  }
  for (const control of controls) {
    control.addEventListener(control.type === 'number' ? 'change' : 'input', () => {
      const key = control.dataset.setting;
      if (control.type === 'radio' && !control.checked) return;
      const value = control.type === 'checkbox' ? control.checked
        : control.type === 'number' ? control.valueAsNumber
          : control.type === 'range' ? Number(control.value) : control.value;
      if (key === 'crouchJump') bindings?.release?.();
      if (control.type === 'number' && !Number.isFinite(value)) { sync(); return; }
      patch({[key]: value});
    });
  }

  function cancelCapture() {
    capturing = false;
    keyButton.classList.remove('listening');
    write(keyButton, keyName(settings.crouchJumpKey));
    write(keyHelp, KEY_HELP);
  }
  function selectPage(tab) {
    cancelCapture();
    if (clearState !== 'clearing') setClear('idle');
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      node(`page-${item.dataset.page}`).hidden = !selected;
    }
    body.scrollTop = 0;
  }
  for (const tab of tabs) tab.addEventListener('click', () => selectPage(tab));
  function closePanel(focus = false) {
    cancelCapture();
    if (clearState !== 'clearing') clearState = 'idle';
    panel.hidden = true;
    opener.setAttribute('aria-expanded', 'false');
    if (focus && available) opener.focus();
  }
  opener.addEventListener('click', () => {
    if (!available) return;
    if (!panel.hidden) { closePanel(true); return; }
    onOpen?.();
    bindings?.release?.();
    panel.hidden = false;
    opener.setAttribute('aria-expanded', 'true');
    sync();
    close.focus();
  });
  close.addEventListener('click', () => closePanel(true));
  keyButton.addEventListener('click', () => {
    capturing = true;
    bindings?.release?.();
    keyButton.classList.add('listening');
    write(keyButton, 'Press a key');
    write(keyHelp, 'Any physical key. Esc cancels; nothing reaches the game.');
  });
  node('reset-layout').addEventListener('click', () => { onResetLayout(); sync(); onChange?.(); });
  node('reset-colors').addEventListener('click', () => { onResetColors(); sync(); onChange?.(); });
  write(keyHelp, KEY_HELP);

  function handleKey(event) {
    if (panel.hidden || !available) return;
    const inside = event.composedPath().includes(host);
    if (capturing) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type !== 'keydown' || event.repeat) return;
      if (event.code === 'Escape') { cancelCapture(); return; }
      if (!event.code || event.code === 'Unidentified') { write(keyHelp, 'That key has no physical code. Try another.'); return; }
      const accepted = bindings?.setKey?.(event.code);
      if (accepted === false) { write(keyHelp, 'That key can’t be used for crouch-jump. Try a letter, digit or modifier.'); return; }
      capturing = false;
      keyButton.classList.remove('listening');
      patch({crouchJumpKey: event.code});
      write(keyHelp, `Bound to ${keyName(event.code)}.`);
      return;
    }
    if (event.type === 'keydown' && event.code === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); closePanel(true); return;
    }
    const tabIndex = tabs.indexOf(event.composedPath()[0]);
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (event.type === 'keydown' && tabIndex !== -1 && keys.includes(event.code)) {
      event.preventDefault();
      const step = event.code === 'ArrowRight' || event.code === 'ArrowDown' ? 1 : -1;
      const index = event.code === 'Home' ? 0 : event.code === 'End' ? tabs.length - 1 : (tabIndex + step + tabs.length) % tabs.length;
      selectPage(tabs[index]);
      tabs[index].focus();
    }
    // Keep settings keystrokes out of the game's global keyboard handlers.
    if (inside) event.stopPropagation();
  }

  return {
    sync,
    handleKey,
    close: closePanel,
    get open() { return !panel.hidden; },
    // Settings are reachable only outside a run (menus).
    setAvailable(next) {
      available = next;
      if (opener.hidden === next) opener.hidden = !next;
      if (!next && !panel.hidden) closePanel();
    },
    setStatus(value) { write(node('status'), value); },
    show(page) {
      available = true;
      opener.hidden = false;
      panel.hidden = false;
      opener.setAttribute('aria-expanded', 'true');
      if (page) selectPage(tabs.find(tab => tab.dataset.page === page) ?? tabs[0]);
      sync();
    },
  };
}
