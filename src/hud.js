import {createCheckpointReferences} from './references.js';
import {createRunReferences} from './run-references.js';
import {isSurfContext} from './visibility.js';
import {createReferenceReplayStore} from './replay-store.js';

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const milliseconds = Math.round(seconds * 1000);
  return `${String(Math.floor(milliseconds / 60000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}
export function formatDelta(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}${Math.abs(rounded).toFixed(digits)}`;
}
const number = (value, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function formatSplitDelta(seconds, referenceUs) {
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(referenceUs)) return null;
  const milliseconds = Math.round((Math.round(seconds * 1e6) - referenceUs) / 1000);
  return {
    text: `${milliseconds > 0 ? '+' : milliseconds < 0 ? '−' : '±'}${(Math.abs(milliseconds) / 1000).toFixed(3)}`,
    tone: milliseconds < 0 ? 'good' : milliseconds > 0 ? 'loss' : 'muted'
  };
}
export function startTone(value, amazingBelow, goodBelow) {
  return !Number.isFinite(value) ? 'muted' : value < amazingBelow ? 'good' : value < goodBelow ? 'warn' : 'loss';
}
export function referenceTone(value, reference, tolerance = 0) {
  if (!Number.isFinite(value) || !Number.isFinite(reference)) return 'muted';
  const difference = Number((value - reference).toFixed(1));
  return difference <= 0 ? 'good' : difference <= tolerance ? 'warn' : 'loss';
}

export function mountHud({getState, getView, getMetrics, getSession, getReferences, getAdapter, settings, onSettings, onResetColors, bindings}) {
  const host = document.createElement('div');
  host.id = 'surfd-qol';
  const root = host.attachShadow({mode: 'open'});
  root.innerHTML = `
    <style>
      :host{all:initial;position:fixed;inset:0;z-index:1000;pointer-events:none;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#e8e5e2;color-scheme:dark;font-size:13px;--accent:#ebbcba;--good:#9ccfd8;--warn:#f6c177;--bad:#eb6f92;--muted:#aaa5a0}
      *,*::before,*::after{box-sizing:border-box} [hidden]{display:none!important}
      button,input,select{font:inherit}button,input,select{accent-color:var(--accent)}
      button{cursor:pointer;color:inherit;background:#272b2f;border:1px solid #484d51;border-radius:8px;padding:9px 13px}button:hover{background:#34393f;border-color:var(--accent)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
      #overlay{position:absolute;left:50%;width:360px;max-width:94vw;height:58px;transform:translate(-50%,-50%) scale(var(--scale,1));transform-origin:center;text-align:center;opacity:var(--opacity,.9);font-variant-numeric:tabular-nums;text-shadow:0 1px 2px #000e,0 0 2px #0008}
      .actual{height:100%;display:flex;justify-content:center;align-items:center}.speed-number{position:relative;display:inline-flex;align-items:baseline}.timer{position:absolute;bottom:calc(100% + 2px);left:0;width:100%;font-size:17px;line-height:1.15;font-weight:650;color:#e8e5e2;letter-spacing:.035em}.speed{color:var(--accent);font-size:50px;line-height:1;font-weight:850;letter-spacing:-.04em}.unit{position:absolute;left:100%;bottom:6px;margin-left:7px;color:#c9c4bf;font-size:10px;font-weight:600;white-space:nowrap}.meta{position:absolute;top:calc(100% + 1px);left:0;width:100%;display:flex;align-items:center;justify-content:center;gap:10px;font-size:10px;line-height:1.2;font-weight:600}.sync{color:#c9c4bf}.state{max-width:220px;color:var(--warn);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.state:empty{display:none}
      .feedback{position:absolute;top:calc(100% + 21px);left:50%;transform:translateX(-50%);display:flex;justify-content:center;gap:22px;white-space:nowrap}.metric{display:flex;flex-direction:column;align-items:center;gap:3px}.label{text-transform:uppercase;font-size:9px;font-weight:750;letter-spacing:.08em;color:#c9c4bf}.metric>.label{order:1}.value{font-size:24px;line-height:1;font-weight:800}.value::after{content:"u/s";font-size:9px;margin-left:3px;font-weight:600;color:#c9c4bf}.good{color:var(--good)}.warn{color:var(--warn)}.loss{color:var(--bad)}.muted{color:var(--muted)}
      .events{position:absolute;bottom:calc(100% + 33px);left:50%;transform:translateX(-50%);width:max-content;max-width:94vw;display:flex;flex-direction:column;gap:10px}.split,.start{margin:0;padding:0;border:0;background:none}.split-head{display:flex;justify-content:center;align-items:baseline;gap:9px;margin-bottom:7px;color:#e8e5e2}.split-head>span:first-child{font-size:9px;font-weight:700;letter-spacing:.06em}.split-head>b{font-size:21px;font-weight:750}.split-head>span:last-child{font-size:17px;font-weight:700}.comparisons{display:flex;justify-content:center;gap:26px}.comparison{display:grid;grid-template-columns:auto auto;align-items:baseline;gap:3px 7px;text-align:left}.reference-label{grid-row:1/3;align-self:center;font-size:10px;font-weight:750;letter-spacing:.04em;color:#c9c4bf}.split-time{font-size:25px;line-height:1;font-weight:800}.split-speed{grid-column:2;font-size:19px;line-height:1;font-weight:750}.split-speed::after,#checkpoint-speed::after{content:"u/s";font-size:9px;margin-left:3px;font-weight:600;color:#c9c4bf}
      .start{display:grid;grid-template-columns:repeat(2,auto);justify-content:center;gap:5px 22px;white-space:nowrap}.start>.label{grid-column:1/-1}.start-reading{display:flex;flex-direction:column;align-items:center;gap:3px}.start b{font-size:24px;line-height:1;font-weight:800}.start small{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#c9c4bf;font-weight:650}.start .unit-inline,#start-speed::after,#start-height::after{font-size:9px;margin-left:3px;font-weight:650}#start-speed::after{content:"u/s"}#start-height::after{content:"u"}.start .label{color:#c9c4bf}
      #open{position:absolute;right:22px;top:18px;pointer-events:auto;box-shadow:0 6px 25px #0005;font-weight:650}#open small{font-size:11px;color:#c9c4bf;margin-left:7px}
      #panel{pointer-events:auto;position:absolute;right:20px;top:65px;width:600px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 85px);display:flex;flex-direction:column;overflow:hidden;border:1px solid #45494b;background:#191b1e;border-radius:16px;box-shadow:0 18px 80px #0009;text-shadow:none;font-size:14px;line-height:1.5;color:#eeeae5}
      #panel header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px 16px}#panel h2{font-size:23px;line-height:1.2;letter-spacing:-.025em;margin:0;font-weight:700}#panel header p{margin:6px 0 0;font-size:12px;color:#b7b3af}#panel button{background:#272b2e;border-color:#45494b;color:#eeeae5}#panel button:hover{background:#34393c;border-color:#ebbcba}#panel :is(button,input,select,summary,[role=tabpanel]):focus-visible{outline:2px solid #ebbcba;outline-offset:3px}#panel input{accent-color:#ebbcba}#close{flex:none}
      #panel .settings-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin:0 24px 16px;padding:4px;background:#101214;border-radius:10px}#panel [role=tab]{border:0;background:transparent;padding:9px 4px;font-size:13px;color:#c1bcb6;border-radius:7px}#panel [role=tab][aria-selected=true]{background:#393333;color:#f2ccca;font-weight:650}
      #panel .settings-body{overflow-y:auto;min-height:0;padding:2px 24px 24px;scrollbar-width:thin;scrollbar-color:#606363 transparent;overscroll-behavior:contain}#panel [role=tabpanel]{outline-offset:-2px}#panel fieldset{min-width:0;border:0;padding:0;margin:0 0 22px}#panel legend{padding:0;margin-bottom:8px;font-size:15px;font-weight:650;color:#eeeae5}#panel p{font-size:12px;line-height:1.6;color:#b7b3af;margin:8px 0 14px}#panel .control{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:44px;padding:7px 0;font-size:14px}#panel .control>span:first-child{min-width:0}#panel .control small{display:block;font-size:12px;line-height:1.4;color:#b7b3af;margin-top:2px}#panel .control input[type=checkbox]{flex:none;width:19px;height:19px;margin:0 2px}
      #panel .control select,#panel input[type=number]{min-width:0;border:1px solid #515658;border-radius:7px;background:#25292c;color:#eeeae5;padding:8px 10px}#panel .control select{width:210px;max-width:52%;font-size:13px}#panel .range,#panel .number-control{display:flex;align-items:center;gap:10px;flex:none}#panel .range{width:240px;max-width:54%}#panel input[type=range]{min-width:0;width:100%;margin:0}#panel output{flex:none;min-width:45px;font-size:12px;text-align:right;color:#d7c4be;font-variant-numeric:tabular-nums}#panel .number-control input{width:90px;text-align:right}#panel .number-control output{min-width:26px;text-align:left}#panel input[type=color]{flex:none;width:46px;height:32px;padding:3px;border:1px solid #515658;border-radius:7px;background:#25292c}
      #panel details{border-top:1px solid #383c3e;margin-top:10px;padding-top:12px}#panel summary{cursor:pointer;padding:4px 0;font-size:13px;font-weight:600;color:#d8cec7}#panel details[open]>summary{margin-bottom:12px}#panel details fieldset{margin:18px 0}#panel .settings-hint{padding:12px 14px;background:#24292b;border-radius:8px;color:#ccc8c2}#panel .settings-hint strong{color:#eeeae5;font-weight:600}#panel .settings-actions{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px}#panel .settings-actions button{font-size:12px}#panel #key{min-width:110px;font-family:ui-monospace,monospace;color:#ebbcba}#panel #key-help{min-height:20px}
      #panel #status{flex:none;margin:0;border-top:1px solid #383c3e;background:#202527;padding:10px 24px;font-size:12px;color:#c4ccca}#panel #status:empty{display:none}#panel header,#panel .settings-tabs{flex-shrink:0}
      #panel .preview-card{margin:0 0 22px;padding:16px;border:1px solid #383c3e;border-radius:10px;background:#141719;text-align:center}#panel .preview-card>p{margin:0 0 12px;font-size:11px;color:#b7b3af}#panel #start-preview{gap:7px 32px}#panel #start-preview .label{font-size:11px;text-transform:none;letter-spacing:0}#panel #start-preview small{font-size:10px;text-transform:none;letter-spacing:0}#panel #start-preview b{font-size:26px}
      #panel .settings-hint>strong{display:block}#panel .settings-hint ul{list-style:none;padding:0;margin:8px 0;display:grid;gap:4px}#panel .settings-hint>span{display:block;font-size:11px;color:#b7b3af}#panel .metric-guide{display:grid;grid-template-columns:80px 1fr;gap:14px 16px;margin:14px 0;font-size:12px;line-height:1.6}#panel .metric-guide dt{font-weight:650;color:#eeeae5}#panel .metric-guide dd{margin:0;color:#b7b3af}
      #panel .color-cue{display:inline-flex;align-items:baseline;gap:8px}#panel .color-cue::before{content:"";display:inline-block;flex:none;width:9px;height:9px;border-radius:50%;background:var(--cue);box-shadow:inset 0 0 0 1px #fff2}#panel .color-cue.good{--cue:var(--good)}#panel .color-cue.warn{--cue:var(--warn)}#panel .color-cue.loss{--cue:var(--bad)}#panel .color-cue.muted{--cue:var(--muted)}#panel .color-cue:is(.good,.warn,.loss,.muted){color:inherit}#panel .cutoff-note{display:grid;gap:8px;font-size:12px;line-height:1.6;color:#b7b3af}#panel .sync-guide{display:flex;flex-wrap:wrap;gap:4px 16px}#panel fieldset>details{margin-top:14px}#panel #key-help{margin-bottom:0}
      @media(max-width:600px){#panel{right:12px;top:58px;max-height:calc(100dvh - 70px)}#panel header{padding:18px 18px 14px}#panel .settings-tabs{margin:0 18px 14px}#panel .settings-body{padding:2px 18px 18px}#open{right:12px;top:12px}.feedback{gap:12px}.metric{gap:3px}}
      @media(max-width:380px){#panel header{padding:16px 12px 12px}#panel h2{font-size:20px}#panel .settings-tabs{margin:0 12px 12px}#panel .settings-body{padding:2px 12px 16px}#panel .control{gap:10px;font-size:13px}#panel .control select{font-size:12px;padding:8px 5px}#panel .range{gap:6px}#panel .number-control input{width:72px}}
    </style>
    <section id="overlay" aria-label="Surf movement HUD" hidden>
      <span id="time" class="timer">—</span>
      <div class="actual"><span class="speed-number"><strong id="speed" class="speed">—</strong><span class="unit">u/s</span></span></div>
      <div class="meta"><span id="sync" class="sync">Sync —</span><span id="run-state" class="state"></span></div>
      <div id="feedback" class="feedback">
        <div id="strafe-metric" class="metric" title="Last completed Air section or after-ramp Surf loss."><span id="strafe-label" class="label">Air</span><span id="strafe" class="value muted">—</span></div>
        <div id="ramp-metric" class="metric" title="Full 3D collision-speed loss summed over the accepted board-entry contacts; later continuous turns do not replace it."><span id="ramp-label" class="label">Board</span><span id="ramp" class="value muted">—</span></div>
      </div>
      <div class="events">
        <div id="start" class="start" title="Speed and feet height at the start exit." hidden><span id="start-label" class="label">Start</span><div class="start-reading"><b id="start-speed"></b><small>Speed</small></div><div class="start-reading"><b id="start-height"></b><small>Height</small></div></div>
        <div id="checkpoint" class="split" hidden><div class="split-head"><span id="checkpoint-label"></span><b id="checkpoint-time">—</b><span id="checkpoint-speed">—</span></div><div class="comparisons"><div id="pb-wrap" class="comparison"><span class="reference-label">PB</span><b id="pb-time" class="split-time muted">—</b><b id="pb" class="split-speed muted">—</b></div><div id="wr-wrap" class="comparison"><span id="wr-label" class="reference-label">KSF WR</span><b id="wr-time" class="split-time muted">—</b><b id="wr" class="split-speed muted">—</b></div></div></div>
      </div>
    </section>
    <button id="open" type="button" aria-expanded="false" aria-controls="panel" hidden>QoL <small>Settings</small></button>
    <section id="panel" role="dialog" aria-labelledby="settings-title" hidden>
      <header><div><h2 id="settings-title">HUD settings</h2><p>Surfd QoL · Saved automatically</p></div><button id="close" type="button" aria-label="Close settings">Close</button></header>
      <nav class="settings-tabs" role="tablist" aria-label="Settings sections">
        <button id="tab-display" type="button" role="tab" aria-selected="true" aria-controls="settings-display" data-page="display">Display</button>
        <button id="tab-feedback" type="button" role="tab" aria-selected="false" aria-controls="settings-feedback" data-page="feedback" tabindex="-1">Feedback</button>
        <button id="tab-style" type="button" role="tab" aria-selected="false" aria-controls="settings-style" data-page="style" tabindex="-1">Style</button>
        <button id="tab-controls" type="button" role="tab" aria-selected="false" aria-controls="settings-controls" data-page="controls" tabindex="-1">Controls</button>
      </nav>
      <div class="settings-body">
        <section id="settings-display" role="tabpanel" aria-labelledby="tab-display" tabindex="0">
          <fieldset><legend>On your screen</legend>
            <label class="control"><span>Custom HUD<small>Replace the native timer and speed</small></span><input data-setting="hud" type="checkbox"></label>
            <label class="control">Strafe sync<input data-setting="showSync" type="checkbox"></label>
            <label class="control">Air &amp; ramp feedback<input data-setting="showFeedback" type="checkbox"></label>
            <label class="control">Start speed &amp; height<input data-setting="showStart" type="checkbox"></label>
            <label class="control"><span>Surf after ramps<small>Show Surf in the Air slot after a ramp</small></span><input data-setting="showSurf" type="checkbox"></label>
          </fieldset>
          <fieldset><legend>Counter refresh</legend>
            <label class="control">Speed<span class="number-control"><input data-setting="speedFps" type="number" min="1" max="1000" step="1"><output data-output="speedFps"></output></span></label>
            <label class="control">Timer<span class="number-control"><input data-setting="timerFps" type="number" min="1" max="1000" step="1"><output data-output="timerFps"></output></span></label>
            <p>Display updates only, limited by your screen’s refresh rate. The game stays uncapped.</p>
          </fieldset>
          <fieldset><legend>Checkpoint comparisons</legend>
            <label class="control">Compare with<select data-setting="checkpointReference"><option value="pb">Personal best</option><option value="wr">World record</option><option value="both">PB &amp; WR</option></select></label>
            <label class="control">World record source<select data-setting="wrSource"><option value="ksf">KSF record route</option><option value="leaderboard">Surfd leaderboard #1</option></select></label>
          </fieldset>
          <details><summary>About these comparisons</summary><p>Time and speed use the same checkpoint in your complete personal-best run and the selected record replay. KSF is “Watch the record route”; the leaderboard option uses Surfd rank 1. This source also applies to WR feedback colors. Unavailable data shows —.</p><p>Changes affect this extension only. The game’s physics and canvas stay untouched.</p></details>
        </section>
        <section id="settings-feedback" role="tabpanel" aria-labelledby="tab-feedback" tabindex="0" hidden>
          <fieldset><legend>Color comparisons</legend>
            <label class="control">Board<select data-setting="boardColorReference"><option value="fixed">Fixed cutoffs</option><option value="pb">Personal best</option><option value="wr">World record</option></select></label>
            <label class="control">Surf<select data-setting="surfColorReference"><option value="fixed">Fixed cutoffs</option><option value="pb">Personal best</option><option value="wr">World record</option></select></label>
            <label class="control">Start<select data-setting="startColorReference"><option value="fixed">Fixed targets</option><option value="pb">Personal best</option><option value="wr">World record</option></select></label>
            <label class="control">Near-reference margin<span class="number-control"><input data-setting="referenceLossTolerance" type="number" min="0" step="0.1" aria-describedby="reference-color-help"><output data-output="referenceLossTolerance"></output></span></label>
            <div id="reference-color-help" class="settings-hint"><strong>PB / WR feedback</strong><ul><li><span class="color-cue good">Equal or better</span></li><li><span class="color-cue warn">Worse, within the margin</span></li><li><span class="color-cue loss">Worse, beyond the margin</span></li><li><span class="color-cue muted">No matching data</span></li></ul><span>Board &amp; Surf use the margin. Start uses only equal-or-better or worse.</span></div>
          </fieldset>
          <fieldset><legend>Air analysis</legend>
            <label class="control">Air value<select data-setting="airMetric" aria-describedby="air-metric-help"><option value="missed">Missed strafe gain</option><option value="braking">Air braking</option><option value="combined">Both combined</option></select></label>
            <p id="air-metric-help"></p>
            <label class="control"><span>Live feedback<small>Update movement feedback while surfing, instead of holding results.</small></span><input data-setting="continuousFeedback" type="checkbox"></label>
            <label class="control"><span>Live strafe window<small>Live feedback only: how much recent movement to compare.</small></span><span class="range"><input data-setting="strafeLookbackSeconds" type="range" min="0.05" max="0.5" step="0.05"><output data-output="strafeLookbackSeconds"></output></span></label>
          </fieldset>
          <details><summary>Fixed targets &amp; cutoffs</summary>
            <p>These values grade Air and any metric set to Fixed above. They never grade PB / WR comparisons.</p>
            <fieldset><legend>Start height</legend>
              <label class="control"><span class="color-cue good">Best below</span><span class="number-control"><input aria-label="Start height best below" data-setting="startHeightAmazing" type="number" min="0" step="0.1"><output data-output="startHeightAmazing"></output></span></label>
              <label class="control"><span class="color-cue warn">Middle below</span><span class="number-control"><input aria-label="Start height middle below" data-setting="startHeightGood" type="number" min="0" step="0.1"><output data-output="startHeightGood"></output></span></label>
            </fieldset>
            <fieldset><legend>Start speed shortfall</legend>
              <label class="control"><span class="color-cue good">Best below</span><span class="number-control"><input aria-label="Start speed shortfall best below" data-setting="startDeficitAmazing" type="number" min="0" step="0.1"><output data-output="startDeficitAmazing"></output></span></label>
              <label class="control"><span class="color-cue warn">Middle below</span><span class="number-control"><input aria-label="Start speed shortfall middle below" data-setting="startDeficitGood" type="number" min="0" step="0.1"><output data-output="startDeficitGood"></output></span></label>
            </fieldset>
            <fieldset><legend>Board loss</legend>
              <label class="control"><span class="color-cue good">Best below</span><span class="number-control"><input aria-label="Board loss best below" data-setting="boardLossAmazing" type="number" min="0" step="0.5"><output data-output="boardLossAmazing"></output></span></label>
              <label class="control"><span class="color-cue warn">Middle below</span><span class="number-control"><input aria-label="Board loss middle below" data-setting="boardLossGood" type="number" min="0" step="0.5"><output data-output="boardLossGood"></output></span></label>
            </fieldset>
            <fieldset><legend>Air / Surf loss</legend>
              <label class="control"><span class="color-cue good">Best below</span><span class="number-control"><input aria-label="Air and Surf loss best below" data-setting="airLossAmazing" type="number" min="0" step="0.5"><output data-output="airLossAmazing"></output></span></label>
              <label class="control"><span class="color-cue warn">Middle below</span><span class="number-control"><input aria-label="Air and Surf loss middle below" data-setting="airLossGood" type="number" min="0" step="0.5"><output data-output="airLossGood"></output></span></label>
            </fieldset>
            <div class="cutoff-note"><span><span class="color-cue loss">Loss</span> outside the middle range. Start speed shortfall is measured from the speed cap; height is measured above the start platform.</span><span>Sync keeps its native thresholds:</span><div class="sync-guide"><span class="color-cue good">95% and above</span><span class="color-cue warn">85% to below 95%</span><span class="color-cue loss">Below 85%</span></div><span>Customize these colors in Style.</span></div>
          </details>
          <details><summary>Analysis details</summary>
            <dl class="metric-guide">
              <dt>Air braking</dt><dd>Speed removed by air input. Tight turns may need it; compare the same turn rather than treating every loss as a mistake.</dd>
              <dt>Missed gain</dt><dd>Gain a better local strafe could add during input. Chasing every gain can lengthen the route. No-input coasting is excluded.</dd>
              <dt>Board</dt><dd>Collision loss during ramp entry. Brief recontacts can join; later turns never change the held result.</dd>
              <dt>Surf</dt><dd>Exit speed versus the entry-speed / height prediction. Covers the whole ramp, including Board—don’t add them.</dd>
              <dt>PB / WR</dt><dd>Matches ramp, checkpoint and visit. Different entries and routes mean “worse” is not proof of an avoidable mistake.</dd>
              <dt>Live feedback</dt><dd>Off by default. On: rolling Strafe / Input and contact Clip readings. Off: held Air, Board and Surf results.</dd>
            </dl>
          </details>
        </section>
        <section id="settings-style" role="tabpanel" aria-labelledby="tab-style" tabindex="0" hidden>
          <div class="preview-card"><p>Palette example · not a measured Start</p><div id="start-preview" class="start" aria-label="Illustrative Start colors, not a reference comparison"><span class="label">Start</span><div class="start-reading"><b id="start-preview-speed" class="good">348<span class="unit-inline">u/s</span></b><small>Speed · Better / best</small></div><div class="start-reading"><b id="start-preview-height" class="loss">+18.0<span class="unit-inline">u</span></b><small>Height · Worse / loss</small></div></div></div>
          <fieldset><legend>Layout</legend>
            <label class="control">Vertical position<span class="range"><input data-setting="y" type="range" min="10" max="90" step="1"><output data-output="y"></output></span></label>
            <label class="control">Size<span class="range"><input data-setting="scale" type="range" min="0.6" max="1.6" step="0.05"><output data-output="scale"></output></span></label>
            <label class="control">Opacity<span class="range"><input data-setting="opacity" type="range" min="0.25" max="1" step="0.05"><output data-output="opacity"></output></span></label>
            <div class="settings-actions"><button id="reset-layout" type="button">Reset layout</button><p>Always horizontally centered</p></div>
          </fieldset>
          <fieldset><legend>HUD palette</legend>
            <label class="control">Speed<input data-setting="speedColor" type="color"></label>
            <label class="control">Better / best<input data-setting="goodColor" type="color"></label>
            <label class="control">Near / fixed middle<input data-setting="warnColor" type="color"></label>
            <label class="control">Worse / loss<input data-setting="badColor" type="color"></label>
            <div class="settings-actions"><button id="reset-colors" type="button">Reset colors</button></div>
          </fieldset>
        </section>
        <section id="settings-controls" role="tabpanel" aria-labelledby="tab-controls" tabindex="0" hidden>
          <fieldset><legend>Crouch-jump</legend>
            <label class="control"><span>Crouch-jump<small>Add a brief crouch tap when jumping</small></span><input data-setting="crouchJump" type="checkbox"></label>
            <div class="control"><span id="key-label">Jump key</span><button id="key" type="button" aria-labelledby="key-label key" aria-describedby="key-help"></button></div>
            <p id="key-help" role="status">Select the key, then press its replacement. Esc cancels.</p>
            <details><summary>How crouch-jump works</summary><p>Crouch lasts one physics tick per press. Jump stays held; separate crouch keys work normally. The binding uses the physical key, regardless of your keyboard layout. No automatic steering.</p></details>
          </fieldset>
          <fieldset><legend>Nullbinds</legend>
            <label class="control">A / D<input data-setting="nullAD" type="checkbox"></label>
            <label class="control">W / Space<input data-setting="nullWSpace" type="checkbox"></label>
            <p>Only one input in each pair is sent: the latest pressed key wins. Release it to resume the other key if it’s still held. When Space takes priority, W input is cut—not existing forward momentum.</p>
          </fieldset>
        </section>
      </div>
      <p id="status" role="status"></p>
    </section>`;
  document.documentElement.append(host);
  const nativeStyle = document.createElement('style');
  nativeStyle.textContent = '#telemetry,#center-speed-hud,#split-comparison{display:none!important}';
  document.head.append(nativeStyle);
  nativeStyle.disabled = true;
  const nativeKeys = document.getElementById('keys');
  const hullState = nativeKeys ? document.createElement('span') : null;
  if (hullState) {
    hullState.className = 'surfd-qol-hull-state standing';
    hullState.hidden = true;
    hullState.textContent = 'Hull: standing';
    nativeKeys.append(hullState);
  }
  const hullStyle = document.createElement('style');
  hullStyle.textContent = '#keys .surfd-qol-hull-state{display:block;min-width:0;padding:0;margin-top:4px;font:10px Tahoma,sans-serif;text-shadow:0 1px 2px #000e}#keys .surfd-qol-hull-state[hidden]{display:none!important}#keys .surfd-qol-hull-state.crouched{color:var(--surfd-qol-good,#9ccfd8)}#keys .surfd-qol-hull-state.standing{color:#aaa5a0}';
  document.head.append(hullStyle);
  const nodes = Object.fromEntries([...root.querySelectorAll('[id]')].map(node => [node.id, node]));
  const controls = [...root.querySelectorAll('[data-setting]')];
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const settingsBody = root.querySelector('.settings-body');
  const replayStore = createReferenceReplayStore({getAdapter});
  const references = createCheckpointReferences({getSession, getReferences, getAdapter, settings, replayStore});
  const runReferences = createRunReferences({getSession, getReferences, getAdapter, settings, replayStore});
  let capturing = false, menuOpen = false, destroyed = false;
  let splitSession = null, splitIndex = -1, splitAt = -Infinity;
  const lossTone = (loss, good, warning) => !Number.isFinite(loss) ? 'muted' : loss <= good ? 'good' : loss <= warning ? 'warn' : 'loss';
  const text = (id, value) => { if (nodes[id].textContent !== value) nodes[id].textContent = value; };
  function syncSettings() {
    host.style.setProperty('--accent', /^#[\da-f]{6}$/i.test(settings.speedColor) ? settings.speedColor : '#ebbcba');
    const nextSpeedMs = 1000 / settings.speedFps, nextTimerMs = 1000 / settings.timerFps;
    if (nextSpeedMs !== speedUpdateMs) { speedUpdateMs = nextSpeedMs; speedSample = -1; }
    if (nextTimerMs !== timerUpdateMs) { timerUpdateMs = nextTimerMs; timerSample = -1; }
    for (const [key, variable, fallback] of [['goodColor','--good','#9ccfd8'],['warnColor','--warn','#f6c177'],['badColor','--bad','#eb6f92']]) {
      host.style.setProperty(variable, /^#[\da-f]{6}$/i.test(settings[key]) ? settings[key] : fallback);
    }
    hullState?.style.setProperty('--surfd-qol-good', host.style.getPropertyValue('--good'));
    const scale = clamp(settings.scale, .6, 1.6);
    nodes.overlay.style.top = `clamp(${140 * scale}px, ${clamp(settings.y, 10, 90)}%, calc(100% - ${92 * scale}px))`;
    nodes.overlay.style.setProperty('--scale', clamp(settings.scale, .6, 1.6));
    nodes.overlay.style.setProperty('--opacity', clamp(settings.opacity, .25, 1));
    for (const control of controls) {
      const key = control.dataset.setting;
      if (control.type === 'checkbox') control.checked = settings[key] !== false;
      else control.value = settings[key];
      const output = root.querySelector(`[data-output="${key}"]`);
      if (!output) continue;
      if (key === 'strafeLookbackSeconds') output.textContent = `${settings[key].toFixed(2)} s`;
      else if (key === 'speedFps' || key === 'timerFps') output.textContent = 'FPS';
      else if (key.startsWith('startHeight')) output.textContent = 'u';
      else if (key === 'referenceLossTolerance' || key.startsWith('startDeficit') || key.startsWith('boardLoss') || key.startsWith('airLoss')) output.textContent = 'u/s';
      else output.textContent = `${Math.round(settings[key] * (key === 'scale' || key === 'opacity' ? 100 : 1))}%`;
    }
    if (!capturing) text('key', settings.crouchJumpKey || 'Space');
    root.querySelector('[data-setting="strafeLookbackSeconds"]').disabled = settings.continuousFeedback !== true;
    text('air-metric-help', settings.airMetric === 'braking'
      ? 'Speed removed by your air input. Tight turns can require it—use it to compare the same turn, not as an error count.'
      : settings.airMetric === 'missed'
        ? 'Extra speed a better local strafe could have added during input. Taking every gain can lengthen the route; coasting is excluded.'
        : 'Air braking + missed strafe gain. Tight turns may require braking; chasing every strafe gain can lengthen the route.');
  }
  function patch(value) {
    onSettings(value);
    syncSettings();
    render();
  }
  for (const control of controls) control.addEventListener(control.type === 'number' ? 'change' : 'input', () => {
    const key = control.dataset.setting;
    const value = control.type === 'checkbox' ? control.checked : control.type === 'number' ? control.valueAsNumber : control.type === 'range' ? Number(control.value) : control.value;
    if (key === 'crouchJump') bindings?.release?.();
    patch({[key]: value});
  });
  function cancelCapture() {
    capturing = false;
    text('key', settings.crouchJumpKey || 'Space');
    text('key-help', 'Select the key, then press its replacement. Esc cancels.');
  }
  function selectPage(tab) {
    cancelCapture();
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      nodes[`settings-${item.dataset.page}`].hidden = !selected;
    }
    settingsBody.scrollTop = 0;
  }
  for (const tab of tabs) tab.addEventListener('click', () => selectPage(tab));
  function closePanel(focus = false) {
    cancelCapture();
    nodes.panel.hidden = true;
    nodes.open.setAttribute('aria-expanded', 'false');
    if (focus && menuOpen) nodes.open.focus();
  }
  nodes.open.addEventListener('click', () => {
    if (!menuOpen) return;
    if (!nodes.panel.hidden) { closePanel(true); return; }
    bindings?.release?.();
    nodes.panel.hidden = false;
    nodes.open.setAttribute('aria-expanded', 'true');
    syncSettings();
    nodes.close.focus();
  });
  nodes.close.addEventListener('click', () => closePanel(true));
  nodes.key.addEventListener('click', () => {
    capturing = true;
    bindings?.release?.();
    text('key', 'Press a key…');
    text('key-help', 'Press a physical keyboard key. Escape cancels; no input is sent to the game.');
  });
  nodes['reset-layout'].addEventListener('click', () => patch({y:82,scale:1,opacity:.9}));
  nodes['reset-colors'].addEventListener('click', () => { onResetColors(); syncSettings(); render(); });
  function onKey(event) {
    if (nodes.panel.hidden || !menuOpen) return;
    const inside = event.composedPath().includes(host);
    if (capturing) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type !== 'keydown' || event.repeat) return;
      if (event.code === 'Escape') { cancelCapture(); return; }
      if (!event.code || event.code === 'Unidentified') { text('key-help', 'That key has no physical code. Please choose another.'); return; }
      const accepted = bindings?.setKey?.(event.code);
      if (accepted === false) { text('key-help', 'That key is reserved. Please choose another.'); return; }
      capturing = false;
      patch({crouchJumpKey: event.code});
      text('key-help', `Bound to physical ${event.code}.`);
      return;
    }
    if (event.type === 'keydown' && event.code === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); closePanel(true); return;
    }
    const tabIndex = tabs.indexOf(event.composedPath()[0]);
    if (event.type === 'keydown' && tabIndex !== -1 && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.code)) {
      event.preventDefault();
      const index = event.code === 'Home' ? 0 : event.code === 'End' ? tabs.length - 1 : (tabIndex + (event.code === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectPage(tabs[index]);
      tabs[index].focus();
    }
    // Keep settings keystrokes out of the game's global keyboard handlers.
    if (inside) event.stopPropagation();
  }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  const menu = document.getElementById('menu');
  const windowHost = document.getElementById('window-host');
  const loadingScreen = document.getElementById('loading-screen');
  const finishScreen = document.getElementById('finish');
  const modalDialogs = document.querySelectorAll('dialog');
  function inSurfContext(snapshot, session, view) {
    return isSurfContext(snapshot, session, view, {
      menuOpen: !!menu && !menu.hidden,
      loading: !!loadingScreen && !loadingScreen.hidden,
      finishOpen: !!finishScreen && !finishScreen.hidden,
      blockingWindowOpen: !!windowHost && !windowHost.hidden && !!windowHost.querySelector('.window:not([hidden])'),
      blockingDialogOpen: !!document.querySelector('dialog:modal'),
      pointerLocked: !!document.pointerLockElement,
    });
  }
  function refreshMenu(snapshot, session, view) {
    if (arguments.length === 0) {
      snapshot = getState?.();
      session = getSession?.();
      view = getView?.(snapshot);
    }
    const currentView = view ?? snapshot?.spectator ?? null;
    const inSurf = inSurfContext(snapshot, session, currentView);
    menuOpen = !inSurf;
    nodes.open.hidden = !menuOpen;
    if (!menuOpen && !nodes.panel.hidden) closePanel();
    const spectator = currentView?.target != null;
    const hasState = spectator ? !!currentView.view?.pose : !!(snapshot?.state ?? session?.state);
    nodes.overlay.hidden = settings.hud === false || !inSurf || !hasState;
    // Keep native in-run telemetry suppressed behind open menus while the
    // custom HUD is enabled; disabling the custom HUD restores it.
    nativeStyle.disabled = settings.hud === false || snapshot == null;
    return inSurf;
  }
  const menuObserver = new MutationObserver(records => {
    for (const {target} of records) {
      if (target === menu || target === windowHost || target === loadingScreen || target === finishScreen ||
        target.matches('.window, dialog')) { refreshMenu(); break; }
    }
  });
  if (menu) menuObserver.observe(menu, {attributes:true,attributeFilter:['hidden','class']});
  if (windowHost) menuObserver.observe(windowHost, {attributes:true,attributeFilter:['hidden','class','data-window'],subtree:true});
  for (const element of [loadingScreen, finishScreen]) {
    if (element) menuObserver.observe(element, {attributes:true,attributeFilter:['hidden']});
  }
  for (const dialog of modalDialogs) menuObserver.observe(dialog, {attributes:true,attributeFilter:['open']});
  function onPointerLockChange() { refreshMenu(); }
  document.addEventListener('pointerlockchange', onPointerLockChange);
  let speedUpdateMs = 1000 / settings.speedFps, timerUpdateMs = 1000 / settings.timerFps;
  let liveFrame = 0, speedSample = -1, timerSample = -1;
  function renderLive(snapshot, session, view, timestamp) {
    const spectator = view?.target != null;
    const pose = spectator ? view.view?.pose : null;
    const nextSpeedSample = Math.floor(timestamp / speedUpdateMs);
    if (nextSpeedSample > speedSample) {
      speedSample = nextSpeedSample;
      const state = spectator ? pose : snapshot?.state ?? session?.state;
      const speed = spectator ? Math.hypot(pose?.vx, pose?.vy) : Math.hypot(state?.velocity?.x, state?.velocity?.y);
      text('speed', Number.isFinite(speed) ? number(speed) : '—');
    }
    const nextTimerSample = Math.floor(timestamp / timerUpdateMs);
    if (nextTimerSample > timerSample) {
      timerSample = nextTimerSample;
      const timer = spectator ? null : snapshot?.run ?? session?.timer?.state;
      text('time', formatTime(spectator ? pose?.seconds : timer?.elapsed));
    }
  }
  function renderLiveFrame(timestamp) {
    liveFrame = 0;
    if (destroyed || nodes.overlay.hidden) return;
    if (Math.floor(timestamp / speedUpdateMs) > speedSample || Math.floor(timestamp / timerUpdateMs) > timerSample) {
      renderLive(null, getSession?.(), getView?.() ?? null, timestamp);
    }
    liveFrame = requestAnimationFrame(renderLiveFrame);
  }
  function render() {
    if (destroyed) return;
    const snapshot = getState?.();
    const session = getSession?.();
    const view = getView?.(snapshot) ?? snapshot?.spectator ?? null;
    const spectator = view?.target != null;
    const pose = spectator ? view.view?.pose : null;
    const inSurf = refreshMenu(snapshot, session, view);
    const state = spectator ? pose : snapshot?.state ?? session?.state;
    const timer = spectator ? null : snapshot?.run ?? session?.timer?.state;
    const metrics = spectator ? null : getMetrics?.();
    const activeReferences = inSurf && !spectator;
    const refs = references.update(activeReferences);
    const runRefs = runReferences.update(metrics?.board, metrics?.surf, activeReferences);
    const enabled = settings.hud !== false && inSurf && !!state;
    nodes.overlay.hidden = !enabled;
    if (enabled && !liveFrame) {
      const timestamp = performance.now();
      speedSample = timerSample = -1;
      renderLive(snapshot, session, view, timestamp);
      liveFrame = requestAnimationFrame(renderLiveFrame);
    }
    const sync = snapshot?.strafeSync?.percentage;
    text('sync', `Sync ${spectator ? '—' : `${number(sync, 1)}${Number.isFinite(sync) ? '%' : ''}`}`);
    nodes.sync.className = `sync ${spectator || !Number.isFinite(sync) ? 'muted' : sync >= 95 ? 'good' : sync >= 85 ? 'warn' : 'loss'}`;
    nodes.sync.title = 'Native strafe sync: best at 95% and above, middle at 85% to below 95%, loss below 85%.';
    nodes.sync.hidden = settings.showSync === false;
    const runState = spectator
      ? `SPECTATING · ${view.view?.player?.name ?? 'PLAYER'}${!pose ? ' · WAITING' : view.view?.stale ? ' · STALE' : ''}`
      : snapshot?.playback ? 'REPLAY' : session?.practice ? 'PRACTICE' : timer?.invalidReason ? 'INVALID' : !session ? 'CONNECT EXTENSION' : timer?.phase === 'finished' ? 'FINISHED' : '';
    text('run-state', runState);
    nodes['run-state'].title = spectator ? runState : timer?.invalidReason || '';
    nodes.feedback.hidden = settings.showFeedback === false;
    const continuous = settings.continuousFeedback === true;
    const airMetric = ['missed', 'braking', 'combined'].includes(settings.airMetric) ? settings.airMetric : 'combined';
    const airMetricLabel = airMetric === 'missed' ? 'Missed' : airMetric === 'braking' ? 'Brake' : 'Air';
    const heldSurf = !continuous && settings.showSurf !== false && Number.isFinite(metrics?.surf?.tick)
      && (!Number.isFinite(metrics?.air?.tick) || metrics.surf.tick >= metrics.air.tick);
    const strafe = continuous ? metrics?.strafe : heldSurf ? metrics.surf : metrics?.air;
    const heldAirLoss = heldSurf ? strafe?.loss : airMetric === 'missed' ? strafe?.missedGain : airMetric === 'braking' ? strafe?.brakingLoss : strafe?.loss;
    const selectedLoss = continuous ? strafe?.loss : heldAirLoss;
    const strafeLoss = strafe?.available && Number.isFinite(selectedLoss) ? selectedLoss : null;
    const ramp = continuous ? metrics?.ramp : metrics?.board;
    const rampLoss = ramp?.available && Number.isFinite(ramp.loss) ? ramp.loss : null;
    const boardReference = runRefs?.board;
    const relativeBoard = !continuous && (settings.boardColorReference === 'pb' || settings.boardColorReference === 'wr');
    const surfReference = runRefs?.surf;
    const relativeSurf = heldSurf && (settings.surfColorReference === 'pb' || settings.surfColorReference === 'wr');
    const surfSourceLabel = settings.surfColorReference === 'pb' ? 'PB' : settings.wrSource === 'leaderboard' ? 'SITE WR' : 'KSF';
    text('strafe', strafeLoss === null ? '—' : formatDelta(-strafeLoss, 1));
    text('ramp', rampLoss === null ? '—' : formatDelta(-rampLoss, 1));
    text('strafe-label', continuous ? strafe?.mode === 'surf' ? 'Input' : 'Strafe' : heldSurf ? 'Surf' : airMetricLabel);
    text('ramp-label', !continuous || ramp?.kind === 'board' ? 'Board' : ramp?.kind === 'contact' ? 'Contact' : 'Clip');
    const lookback = Number.isFinite(strafe?.windowSeconds) ? strafe.windowSeconds : settings.strafeLookbackSeconds;
    nodes['strafe-metric'].title = !continuous
      ? heldSurf
        ? `Net ramp exit: ${number(strafe?.exitSpeed, 1)} u/s actual versus ${number(strafe?.expectedExitSpeed, 1)} u/s gravity-only expected. Includes Board and complete first/last contact ticks; brief same-ramp skips retain the first entry. Positive is net gain, negative is net loss after height conversion. No post-exit ticks are counted; do not add Board. ${strafe?.reason === 'above-gravity-only-height' ? 'No real gravity-only baseline exists at this exit height. ' : strafe?.reason ? 'Ambiguous contact or invalid endpoint/gravity data. ' : ''}${relativeSurf ? surfReference?.status === 'ready' ? `${surfSourceLabel} matched Surf: ${formatDelta(-surfReference.loss, 1)} u/s. Loss difference: ${formatDelta((strafeLoss ?? 0) - surfReference.loss, 1)} u/s (positive is worse). Teal: at or better; gold: up to ${number(settings.referenceLossTolerance, 1)} u/s worse; red: beyond. Compared to 0.1 u/s precision. Number remains raw.` : `${surfSourceLabel} reference ${surfReference?.status ?? 'missing'}; no comparison color.` : 'Fixed colors use raw net-loss cutoffs.'} Same ramp, checkpoint and visit; entry speeds and routes may differ. Not an avoidable-loss proof.`
        : `Last completed air section: ${number(strafe?.brakingLoss, 1)} u/s Air braking + ${number(strafe?.missedGain, 1)} u/s Missed strafe gain over ${number(strafe?.measuredSeconds, 2)} s of input. Showing ${airMetricLabel}. Air braking is actual speed removed by input; tight turns may require it. Missed gain is extra speed from a better local strafe; taking it may lengthen the route. Coasting/no-input excluded. Neither is a route-optimal error count.`
      : strafe?.mode === 'surf'
        ? 'Live same-pressure ramp-input comparison, not turn clipping. ±0 means no better local acceleration at the same holding pressure; — means unsupported.'
        : `Live missed local acceleration over ${number(lookback, 2)} s, including input braking. Not a route optimum.`;
    nodes['ramp-metric'].title = !continuous
      ? `Last Board: ${number(ramp?.entryContacts)} contact clips in the fixed ${number(ramp?.entryWindowSeconds, 2)} s entry window. Brief recontacts can join; continuous turns and later seams never update it. ${relativeBoard ? boardReference?.status === 'ready' ? `${settings.boardColorReference.toUpperCase()} matched loss: ${number(boardReference.loss, 1)} u/s. Loss difference: ${formatDelta((rampLoss ?? 0) - boardReference.loss, 1)} u/s (positive is worse). Teal: at or better; gold: up to ${number(settings.referenceLossTolerance, 1)} u/s worse; red: beyond. Compared to 0.1 u/s precision. Number remains raw.` : `${settings.boardColorReference.toUpperCase()} reference ${boardReference?.status ?? 'missing'}; no comparison color.` : 'Fixed colors use raw-loss cutoffs.'} Full-3D collision loss only, not an initial-to-final speed difference or proof of avoidability.`
      : 'Live collision loss only: Board is first contact; Clip is the last 0.50 simulated seconds of continued ramp contact. Gravity/conversion excluded; required turns can still clip.';
    nodes.strafe.className = `value ${continuous ? lossTone(strafeLoss, .5, 5) : relativeSurf ? referenceTone(strafeLoss, surfReference?.status === 'ready' ? surfReference.loss : null, settings.referenceLossTolerance) : startTone(strafeLoss, settings.airLossAmazing, settings.airLossGood)}`;
    nodes.ramp.className = `value ${relativeBoard ? referenceTone(rampLoss, boardReference?.status === 'ready' ? boardReference.loss : null, settings.referenceLossTolerance) : startTone(rampLoss, settings.boardLossAmazing, settings.boardLossGood)}`;
    const start = metrics?.start;
    nodes.start.hidden = spectator || settings.showStart === false || !start?.available || start.age > 1800;
    const startReference = runRefs?.start;
    const relativeStart = settings.startColorReference === 'pb' || settings.startColorReference === 'wr';
    const startSourceLabel = settings.startColorReference === 'pb' ? 'PB' : settings.wrSource === 'leaderboard' ? 'SITE WR' : 'KSF';
    text('start-speed', start?.available ? number(start.speed) : '—');
    text('start-height', Number.isFinite(start?.heightAboveFloor) ? formatDelta(start.heightAboveFloor, 1) : '—');
    const referenceReady = startReference?.status === 'ready';
    nodes['start-speed'].className = relativeStart
      ? referenceTone(referenceReady ? startReference.speed : null, start?.available ? start.speed : null)
      : startTone(start?.available ? Math.max(0, -start.speedDelta) : null, settings.startDeficitAmazing, settings.startDeficitGood);
    nodes['start-height'].className = relativeStart
      ? referenceTone(start?.heightAboveFloor, referenceReady ? startReference.heightAboveFloor : null)
      : startTone(Number.isFinite(start?.heightAboveFloor) ? Math.max(0, start.heightAboveFloor) : null, settings.startHeightAmazing, settings.startHeightGood);
    const startReferenceNote = relativeStart
      ? `${startSourceLabel} reference ${startReference?.status ?? 'missing'}: ${number(startReference?.speed, 1)} u/s, ${number(startReference?.heightAboveFloor, 1)} u above platform. Teal: at or better; red: worse; grey: unavailable. Compared to 0.1-unit precision.`
      : 'Fixed cutoffs grade speed deficit to the native cap and height above the actual platform.';
    nodes.start.title = startReferenceNote;
    nodes['start-speed'].title = `${number(start?.speed, 1)} u/s at exit; ${start?.label === 'Unrestricted start' ? 'uncapped start' : `${formatDelta(start?.speedDelta, 1)} u/s versus ${number(start?.targetSpeed)} cap`}. ${startReferenceNote}`;
    nodes['start-height'].title = `Feet height above the start platform; lower is better. ${startReferenceNote}`;
    const replayDuck = session?.state?.ducked;
    const showHullState = !!hullState && snapshot?.playback === true && !spectator && inSurf && typeof replayDuck === 'boolean';
    if (hullState) {
      hullState.hidden = !showHullState;
      if (showHullState) {
        hullState.className = `surfd-qol-hull-state ${replayDuck ? 'crouched' : 'standing'}`;
        const hullLabel = replayDuck ? 'Hull: crouched' : 'Hull: standing';
        if (hullState.textContent !== hullLabel) hullState.textContent = hullLabel;
      }
    }
    const speeds = spectator ? null : session?.checkpointSpeeds;
    const index = (speeds?.length ?? 0) - 1;
    const viewedCheckpoint = Number.isInteger(pose?.checkpoints) ? pose.checkpoints : null;
    const splitOwner = spectator ? view.target : session;
    const progressIndex = spectator ? (viewedCheckpoint ?? -1) : index;
    if (splitSession !== splitOwner || splitIndex !== progressIndex) {
      splitSession = splitOwner;
      splitIndex = progressIndex;
      splitAt = performance.now();
    }
    if (spectator) {
      const progress = view.view?.detailed
        ? `CP ${viewedCheckpoint ?? '—'}${Number.isInteger(pose?.stage) && pose.stage > 0 ? ` · S${pose.stage}` : ''}`
        : 'CP —';
      nodes.checkpoint.hidden = !pose || !viewedCheckpoint || pose.phase === 'ready' || performance.now() - splitAt > 6500;
      text('checkpoint-label', pose ? progress : '');
      text('checkpoint-time', '—');
      text('checkpoint-speed', '—');
    } else {
      nodes.checkpoint.hidden = index < 0 || performance.now() - splitAt > 6500;
      const kind = session?.map?.stages?.length ? 'S' : 'CP';
      text('checkpoint-label', index >= 0 ? `${kind}${index + 1}` : '');
      text('checkpoint-time', formatTime(timer?.splits?.[index]));
      text('checkpoint-speed', index >= 0 ? number(speeds[index]) : '—');
    }
    const showPersonal = settings.checkpointReference !== 'wr';
    const showRecord = settings.checkpointReference !== 'pb';
    nodes['pb-wrap'].hidden = spectator || !showPersonal;
    nodes['wr-wrap'].hidden = spectator || !showRecord;
    const recordSource = refs?.recordSource ?? settings.wrSource;
    text('wr-label', recordSource === 'leaderboard' ? 'SITE WR' : 'KSF WR');
    for (const [id, values, status] of [['pb',refs?.own,refs?.ownStatus],['wr',refs?.record,refs?.recordStatus]]) {
      const delta = !spectator && index >= 0 && Number.isFinite(values?.[index]) ? speeds[index] - values[index] : null;
      text(id, delta === null ? '—' : formatDelta(delta));
      nodes[id].className = `split-speed ${delta === null ? 'muted' : delta < 0 ? 'loss' : 'good'}`;
      nodes[id].title = delta === null
        ? status === 'loading' ? id === 'wr' ? `Loading ${recordSource === 'leaderboard' ? 'Surfd leaderboard #1' : 'imported KSF route'}…` : 'Reconstructing this run’s replay…' : 'No matching checkpoint-speed reference available'
        : `Reference: ${number(values[index], 1)} u/s`;
      const splitDelta = !spectator && index >= 0
        ? formatSplitDelta(timer?.splits?.[index], id === 'pb' ? refs?.ownSplitsUs?.[index] : refs?.recordSplitsUs?.[index])
        : null;
      text(`${id}-time`, splitDelta?.text ?? '—');
      nodes[`${id}-time`].className = `split-time ${splitDelta?.tone ?? 'muted'}`;
    }
    const bindingStatus = bindings?.status?.();
    const bindingText = typeof bindingStatus === 'string' ? bindingStatus : bindingStatus?.message;
    const analysisStatus = metrics?.status === 'unsupported-physics' ? 'Unsupported acceleration physics; strafe feedback excluded.' : metrics?.status;
    const feedbackStatus = spectator
      ? 'Spectator coaching unavailable: native network snapshots contain pose and optional input bits, not a local physics session.'
      : !session ? 'Physics adapter unavailable; exact feedback and references need the extension connection.' : analysisStatus;
    text('status', [feedbackStatus, bindingText].filter(Boolean).join(' · '));
  }
  syncSettings();
  render();
  const interval = setInterval(render, 67);
  return {observeFinish() { references.update(false); }, destroy() {
    destroyed = true;
    clearInterval(interval);
    cancelAnimationFrame(liveFrame);
    references.destroy();
    runReferences.destroy();
    replayStore.destroy();
    menuObserver.disconnect();
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    bindings?.release?.();
    hullState?.remove();
    hullStyle.remove();
    nativeStyle.remove();
    host.remove();
  }};
}
