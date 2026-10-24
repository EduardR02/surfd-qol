// Shadow-root styles for the in-run HUD and the settings panel.
import {FONT_FAMILY} from './hud-view.js';

// The HUD is drawn straight onto the scene: no boxes, no backdrops. Legibility
// over bright, pastel or busy scenery comes from a hairline dark edge painted
// under each glyph plus a soft, tight shadow. The speed is the one large
// element; everything else is small and quiet.
export const hudStyles = `
:host{all:initial;position:fixed;inset:0;z-index:1000;pointer-events:none;color-scheme:dark;
  --accent:#ebbcba;--good:#9ccfd8;--warn:#f6c177;--bad:#eb6f92;--muted:#b4aca8;--paper:#f6f0ec;
  --edge:rgba(16,10,13,.74);
  font-family:"${FONT_FAMILY}",ui-sans-serif,system-ui,sans-serif;font-synthesis:none;
  -webkit-font-smoothing:antialiased}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}

.hud{position:absolute;left:50%;top:var(--y,82%);width:0;height:0;transform:scale(var(--scale,1));transform-origin:0 0;
  opacity:var(--opacity,1);color:var(--paper);white-space:nowrap;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"case" 1;
  -webkit-text-stroke:1.5px var(--edge);paint-order:stroke fill;
  text-shadow:0 1px 2px rgba(0,0,0,.5),0 0 10px rgba(0,0,0,.28)}
.hud b{font-weight:700}
.good{color:var(--good)}.warn{color:var(--warn)}.loss{color:var(--bad)}.muted{color:var(--muted)}

/* Speed: centred on the anchor. Colour eases so an energy tint never flickers. */
.speed{position:absolute;left:0;top:0;transform:translate(-50%,-52%);font-size:70px;line-height:1;font-weight:700;
  letter-spacing:-.02em;color:var(--accent);-webkit-text-stroke-width:1.75px;transition:color .18s ease-out}
.speed.e-good{color:var(--good)}.speed.e-loss{color:var(--bad)}

/* Clock row: with sync and a run label, the timer is centred and they hang off
   either side. With only one of them, the pair centres as a group instead, so a
   ranked run (no label) doesn't lean towards the sync. */
.clock{position:absolute;left:0;bottom:39px;width:460px;transform:translateX(-50%);display:grid;grid-template-columns:1fr auto 1fr;
  align-items:baseline;column-gap:13px}
.clock:has(>.state:empty),.clock:has(>.sync[hidden]){display:flex;justify-content:center}
.time{grid-column:2;font-size:20px;line-height:1.1;font-weight:700;letter-spacing:.01em}
.f{font-size:.74em;letter-spacing:.01em}
/* Times keep even, full-strength digits so their weight sits on the centre line. */
.time .f,.split-time .f{font-size:1em;letter-spacing:inherit}
.sync{grid-column:1;justify-self:end;font-size:14px;font-weight:700}
.state{grid-column:3;justify-self:start;max-width:210px;overflow:hidden;text-overflow:ellipsis;font-size:11px;font-weight:700;
  letter-spacing:.09em;color:var(--warn)}
.state:empty{display:none}

/* Feedback: fixed-width slots, so three slots put the newest result exactly under the speed and a sole slot centres. */
.feedback{position:absolute;left:0;top:41px;transform:translateX(-50%);display:flex;justify-content:center}
.slot{width:92px;display:flex;flex-direction:column;align-items:center}
.val{display:block;font-size:26px;line-height:1;font-weight:700}
.lab{display:block;margin-top:5px;font-size:11px;line-height:1;font-weight:700;letter-spacing:.07em;color:var(--paper);opacity:.8;
  -webkit-text-stroke-width:1.25px}
.slot.stale .val{color:var(--muted);font-weight:400;opacity:.5}
.slot.stale .lab{opacity:.45}

/* Events: start flash and checkpoint splits, stacked upward above the clock. */
.events{position:absolute;left:0;bottom:78px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:14px}
.flip .events{bottom:auto;top:104px;flex-direction:column-reverse}
.start{display:flex;justify-content:center}
.start .cell{width:92px;display:flex;flex-direction:column;align-items:center}
.start .val{font-size:24px}
.split{display:flex;flex-direction:column;align-items:center;gap:7px}
.split-head{display:flex;align-items:baseline;gap:10px}
.cp{font-size:12px;font-weight:700;letter-spacing:.07em;opacity:.85}
.split-time{font-size:22px;line-height:1}
.split-speed{font-size:22px;line-height:1;color:var(--accent)}
.refs{display:flex;justify-content:center;gap:30px}
.ref{display:flex;flex-direction:column;align-items:center}
.pair{display:flex;align-items:baseline;gap:9px}
.dt{font-size:22px;line-height:1}
.ds{font-size:16px;line-height:1}
`;
