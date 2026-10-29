// Runs panel, History page and Zen pill styles. The panel is neutral graphite
// glass, so the four HUD colours read at full strength: rose for speed, PB,
// progress and play; teal, gold and red only where something is graded
// against your PB or the WR. Switches stay neutral. The slanted bar is the
// unit of progress: checkpoints, run meters, marks.
export const runsStyles = `
#runs-panel{--ink:rgba(18,18,18,.93);--ink-2:#1c1c1c;--line:rgba(255,255,255,.08);--line-2:rgba(255,255,255,.15);
  --text:#eeeeee;--text-2:#a8a8a8;--text-3:#7a7a7a;--on-accent:#141414;
  --above:calc(var(--dock-bottom,20px) + var(--dock-height,42px) + 12px);
  position:absolute;right:var(--dock-edge,20px);bottom:var(--above);width:540px;max-width:calc(100vw - 24px);
  max-height:min(880px,calc(100dvh - var(--above) - 16px));display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;
  color:var(--text);font-size:13.5px;line-height:1.4;text-shadow:none;-webkit-text-stroke:0;font-variant-numeric:tabular-nums;
  background:var(--ink);-webkit-backdrop-filter:blur(26px) saturate(1.5);backdrop-filter:blur(26px) saturate(1.5);border-radius:18px;
  box-shadow:0 0 0 1px var(--line-2),0 30px 80px rgba(0,0,0,.62),0 2px 8px rgba(0,0,0,.3);animation:rn-in .16s ease-out}
#runs-panel.over-replay{right:20px;bottom:var(--rn-bottom,120px);max-height:min(760px,calc(100dvh - var(--rn-bottom,120px) - 16px))}
@keyframes rn-in{from{opacity:0;transform:translateY(6px)}}
:where(#runs-panel) button{font:inherit;color:inherit;cursor:pointer}
:where(#runs-panel) button:disabled{cursor:default}
#runs-panel :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#runs-panel:focus{outline:none}
#runs-panel svg{display:block;width:16px;height:16px}
.rn-spd{color:var(--accent)}
.rn .f{font-size:.74em}

.launcher .rn-glyph{display:flex;gap:2px}
.rn-glyph i{width:4px;height:14px;border-radius:1px;background:var(--accent);transform:skewX(-18deg)}
.rn-glyph i:nth-child(2){opacity:.66}.rn-glyph i:nth-child(3){opacity:.36}

/* Header: the map is the title and the way to other maps. */
.rn-head{flex:none;display:flex;align-items:center;gap:10px;padding:14px 12px 8px 18px}
.rn-map{display:flex;align-items:center;gap:8px;min-width:0;margin-left:-6px;padding:4px 8px 4px 6px;border:0;border-radius:9px;background:none;
  font-size:19px;font-weight:700;letter-spacing:-.005em}
.rn-map::before{content:"";flex:none;width:5px;height:17px;border-radius:1.5px;background:var(--accent);transform:skewX(-18deg)}
.rn-map span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rn-map svg{flex:none;fill:none;stroke:var(--text-2);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;transition:transform .15s}
.rn-map[aria-expanded=true] svg{transform:rotate(180deg)}
.rn-map:hover:not(:disabled){background:rgba(255,255,255,.07)}
#runs-panel .rn-map:disabled svg{display:none}
.rn-views{margin-left:auto;flex:none;display:flex;gap:2px}
#runs-panel .rn-views button{position:relative;padding:7px 11px 9px;border:0;border-radius:8px;background:none;font-size:13.5px;font-weight:700;color:var(--text-3)}
#runs-panel .rn-views button:hover:not(:disabled){color:var(--text)}
#runs-panel .rn-views button[aria-selected=true]{color:var(--text)}
#runs-panel .rn-views button::after{content:"";position:absolute;left:calc(50% - 12px);bottom:1px;width:24px;height:3px;border-radius:2px;background:var(--accent);
  transform:skewX(-24deg) scaleX(0);transition:transform .15s}
#runs-panel .rn-views button[aria-selected=true]::after{transform:skewX(-24deg)}
.rn.blank .rn-views{visibility:hidden}
.rn-close{flex:none;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:10px;background:none;color:var(--text-2)}
.rn-close:hover{background:rgba(255,255,255,.08);color:var(--text)}
.rn-close svg{fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}

.rn-maps{position:absolute;z-index:2;top:54px;left:12px;width:min(360px,calc(100% - 24px));max-height:min(360px,calc(100% - 70px));overflow-y:auto;
  padding:6px;border-radius:13px;background:var(--ink-2);box-shadow:0 0 0 1px var(--line-2),0 20px 44px rgba(0,0,0,.6)}
.rn-maps button{display:grid;grid-template-columns:minmax(0,1fr) auto 70px;align-items:baseline;gap:12px;width:100%;padding:9px 10px;border:0;
  border-radius:8px;background:none;text-align:left}
.rn-maps button:hover,.rn-maps button[aria-selected=true]{background:rgba(255,255,255,.08)}
.rn-map-name{display:flex;align-items:center;min-width:0;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rn-map-meta{font-size:12px;color:var(--text-3);text-align:right}
.rn-here{flex:none;display:inline-block;width:4px;height:12px;margin-right:9px;border-radius:1px;background:var(--accent);transform:skewX(-18deg)}

.rn-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;outline:none;padding-bottom:10px;
  scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
.rn-status{flex:none;margin:0;padding:10px 20px 12px;border-top:1px solid var(--line);font-size:12.5px;color:var(--text-2)}
.rn-status:empty{display:none}
.rn-status.error{color:var(--bad)}

/* Headline: the PB set like the HUD's numbers, the map's totals beside it. */
.rn-top{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:14px 28px;padding:12px 20px 20px}
.rn-pb-line{display:flex;align-items:center;gap:14px}
.rn-pb-time{font-size:48px;line-height:.95;font-weight:700;letter-spacing:-.025em;white-space:nowrap}
.rn-pb-time .f{color:var(--text-2);letter-spacing:-.01em}
.rn-pb-time.empty{font-size:26px;line-height:1.2;letter-spacing:-.01em;color:var(--text-2)}
.rn-pb-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin-top:9px;font-size:12.5px;color:var(--text-2)}
.rn-lab{font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--accent)}
.rn-stats{display:grid;grid-template-columns:auto auto;gap:12px 24px;margin:0}
.rn-stat{display:flex;flex-direction:column;align-items:flex-end}
.rn-stat dd{margin:0;font-size:19px;line-height:1;font-weight:700}
.rn-stat dt{margin-top:5px;font-size:11px;line-height:1;font-weight:700;letter-spacing:.05em;color:var(--text-3)}

.rn h3{display:flex;align-items:baseline;gap:10px;margin:0 0 12px;font-size:13px;font-weight:700;color:var(--text)}
.rn h3 span{font-size:12px;font-weight:400;color:var(--text-3)}

/* Checkpoint bests: one slanted bar per checkpoint, in the colour of how it compares with PB pace. */
.rn-pace{padding:0 20px 20px}
.rn-cps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(78px,1fr));gap:14px 18px}
.rn-cps li{display:flex;flex-direction:column;min-width:0;color:var(--text)}
.rn-cps li.good{color:var(--good)}.rn-cps li.pb{color:var(--accent)}.rn-cps li.loss{color:var(--bad)}
.rn-cps li>i{height:6px;margin:0 3px 8px;border-radius:1.5px;transform:skewX(-24deg);background:rgba(255,255,255,.16)}
.rn-cps .good>i{background:var(--good)}.rn-cps .pb>i{background:var(--accent)}.rn-cps .loss>i{background:var(--bad)}
.rn-cp{display:flex;justify-content:space-between;gap:6px;font-size:11.5px;font-weight:700;color:var(--text-2)}
.rn-cp .rn-spd{font-size:11px}
.rn-cp-time{margin-top:3px;font-size:16px;line-height:1.2}
.rn-cps li.muted .rn-cp-time{color:var(--text)}
.rn-cps em{margin-top:2px;font-style:normal;font-size:12px;font-weight:700;opacity:.85}
.rn-cps li.muted em{display:none}

/* Latest attempt: its own band, tinted with the accent. */
.rn-latest{margin:0 12px 6px;padding:12px 0 4px;border-radius:13px;background:color-mix(in srgb,var(--accent) 7%,transparent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 16%,transparent)}
.rn-latest h3{margin:0 8px 4px 16px}
.rn-latest .rn-sub{margin-top:10px}
#runs-panel .rn-latest h3 .rn-also{font-size:11.5px;font-weight:700;color:var(--accent)}
.rn-dash{width:4px;height:12px;margin-right:-2px;align-self:center;flex:none;border-radius:1px;background:var(--accent);transform:skewX(-18deg)}

/* Runs: time, result, progress, start speed, when, watch. */
.rn-row{display:grid;grid-template-columns:96px 70px minmax(48px,1fr) 40px 66px 30px;align-items:center;gap:10px;min-height:42px;padding:0 8px;border-radius:9px}
.rn-latest .rn-row{margin:0 8px}
.rn-list{list-style:none;margin:0;padding:0 12px}
.rn-list li+li .rn-row{box-shadow:0 -1px 0 var(--line)}
.rn-list .rn-row:hover{background:rgba(255,255,255,.045);box-shadow:none}
.rn-list li:hover+li .rn-row{box-shadow:none}
.rn-row.now{background:color-mix(in srgb,var(--accent) 9%,transparent)}
.rn-cols{display:grid;grid-template-columns:96px 70px minmax(48px,1fr) 40px 66px 30px;gap:10px;padding:16px 20px 6px;
  font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--text-3)}
.rn-cols span:first-child{grid-column:1/4;font-size:13px;letter-spacing:0;color:var(--text)}
.rn-cols span:nth-child(2),.rn-cols span:nth-child(3){display:none}
.rn-cols span:nth-child(4),.rn-cols span:nth-child(5){text-align:right}
.rn-time{font-size:14.5px;font-weight:700;white-space:nowrap}
.rn-time .f{color:var(--text-2)}
.rn-what{display:flex;gap:4px;min-width:0}
.rn-res{font-size:12.5px;font-weight:700;white-space:nowrap}
.rn-res.good{color:var(--good)}.rn-res.loss{color:var(--bad)}.rn-res.pb{color:var(--accent);letter-spacing:.08em;font-size:11.5px}
.rn-res.reach{font-weight:400;color:var(--text-3)}
.rn-tag{padding:2px 6px 1px;border-radius:5px;font-size:11px;font-weight:700;letter-spacing:.03em}
.rn-tag.practice{color:var(--warn);background:color-mix(in srgb,var(--warn) 13%,transparent)}
.rn-tag.invalid{color:var(--bad);background:color-mix(in srgb,var(--bad) 14%,transparent)}
.rn-meter{display:flex;gap:3px;padding-left:3px}
.rn-meter i{flex:0 1 14px;min-width:5px;height:7px;border-radius:1px;transform:skewX(-22deg);background:rgba(255,255,255,.13)}
.rn-meter i.on{background:var(--accent)}
.rn-reach{font-size:12.5px;color:var(--text-2)}
.rn-start{text-align:right;font-size:13px;font-weight:700}
.rn-when{text-align:right;font-size:12.5px;color:var(--text-3);white-space:nowrap}

/* Watch: one fixed size whatever it's doing, so nothing beside it moves. */
.rn-watch{position:relative;flex:none;width:30px;height:30px;display:grid;place-items:center;padding:0;border:0;border-radius:50%;
  background:rgba(255,255,255,.09);color:var(--text)}
#runs-panel .rn-watch svg{width:14px;height:14px;fill:currentColor}
.rn-watch:hover:not(:disabled){background:var(--accent);color:var(--on-accent)}
.rn-watch:disabled{opacity:.28}
.rn-watch.big{width:40px;height:40px;background:var(--accent);color:var(--on-accent)}
#runs-panel .rn-watch.big svg{width:17px;height:17px}
.rn-watch.big:hover:not(:disabled){filter:brightness(1.08)}
.rn-watch.now{opacity:1;background:none;color:var(--accent);box-shadow:inset 0 0 0 1.5px var(--accent)}
.rn-watch[aria-busy=true]{opacity:1}
.rn-watch[aria-busy=true] svg{visibility:hidden}
.rn-watch[aria-busy=true]::after{content:"";position:absolute;inset:7px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:rn-spin .7s linear infinite}
@keyframes rn-spin{to{transform:rotate(1turn)}}

/* Ramps: your best on each, against the PB or WR run. */
.rn-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 20px 8px}
.rn-vs{margin-left:auto;font-size:12px;color:var(--text-3)}
.rn-seg{display:flex;padding:3px;gap:2px;border-radius:10px;background:rgba(0,0,0,.35);box-shadow:inset 0 0 0 1px var(--line)}
.rn-seg button{padding:5px 12px;border:0;border-radius:7px;background:none;font-size:12.5px;font-weight:700;color:var(--text-3)!important}
.rn-seg button:hover{color:var(--text)!important}
.rn-seg button[aria-checked=true]{background:rgba(255,255,255,.13);color:var(--text)!important;box-shadow:0 1px 2px rgba(0,0,0,.35)}
.rn-caption{display:flex;align-items:baseline;gap:12px;margin:0 20px 6px;font-size:12px;color:var(--text-2)}
.rn-caption span{flex:1}
.rn-reset{flex:none;padding:4px 10px;border:0;border-radius:8px;background:rgba(255,255,255,.07);color:var(--text-2)!important;font-size:12px;font-weight:700}
.rn-reset:hover:not(:disabled){background:rgba(255,255,255,.12);color:var(--text)!important}
.rn-reset:disabled{opacity:.5}
.rn-reset.danger{color:var(--bad)!important;background:color-mix(in srgb,var(--bad) 14%,transparent)}
.rn-reset.danger:hover:not(:disabled){background:color-mix(in srgb,var(--bad) 22%,transparent)}
.rn-reset-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin:0 20px 8px;font-size:12px;color:var(--text)}
.rn-reset-confirm span{flex:1 1 220px}
.rn-reset-confirm small{font-size:12px;color:var(--text-3)}
/* Watching a ramp: the chips in an open row play it in each replay. */
.rn-tri{flex:none;width:8px;height:9px;margin-right:7px;background:currentColor;clip-path:polygon(0 0,100% 50%,0 100%);opacity:.55}
.rn-ramp-play{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px}
.rn-chip{display:inline-flex;align-items:center;height:28px;padding:0 11px 0 10px;border:0;border-radius:999px;background:rgba(255,255,255,.08);font-size:12.5px;font-weight:700}
.rn-chip .rn-tri{color:var(--accent);opacity:1}
.rn-chip:hover:not(:disabled){background:var(--accent);color:var(--on-accent)!important}
.rn-chip:hover:not(:disabled) .rn-tri{color:var(--on-accent)}
.rn-chip:disabled{opacity:.35}
.rn-chip[aria-busy=true]{opacity:1}
.rn-chip[aria-busy=true] .rn-tri{clip-path:none;border-radius:50%;background:none;border:1.5px solid currentColor;border-right-color:transparent;opacity:1;animation:rn-spin .7s linear infinite}
.rn-play-note{flex:1 0 100%;margin-top:2px;font-size:11.5px;color:var(--text-3)}
.rn-note{margin:0 20px 6px;font-size:12.5px;line-height:1.45;color:var(--text-2);max-width:56ch}
.rn-legend{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 20px 6px;font-size:12px;color:var(--text-2)}
.rn-legend span::before{content:"";display:inline-block;width:4px;height:11px;margin-right:7px;border-radius:1px;transform:skewX(-18deg);vertical-align:-1px}
.rn-legend .good::before{background:var(--good)}.rn-legend .warn::before{background:var(--warn)}.rn-legend .loss::before{background:var(--bad)}
/* Ramps: one row per ramp, read at a glance. Its name and reach stay quiet;
   only the one number (the whole ramp against the reference) and its bar,
   on one scale across the map, carry colour. The chevron opens the rest. */
.rn-ramps{padding:0 12px 8px}
.rn-rr{display:grid;grid-template-columns:96px 40px minmax(40px,1fr) 78px 24px;align-items:center;gap:12px;min-height:36px;padding:0 4px 0 8px;border-radius:8px}
.rn-rr.open{border-radius:8px 8px 0 0;background:rgba(255,255,255,.045)}
.rn-rr:not(.rn-rh){cursor:pointer}
.rn-rr:not(.rn-rh):hover{background:rgba(255,255,255,.045)}
.rn-rh{position:sticky;top:0;z-index:1;min-height:0;padding-top:7px;padding-bottom:6px;border-radius:0;background:rgba(10,10,10,.55);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:0 1px 0 var(--line)}
.rn-rh span{font-size:11px;font-weight:700;letter-spacing:.07em;color:var(--text-3);text-align:right;white-space:nowrap}
.rn-sec{display:flex;align-items:center;padding:16px 8px 4px}
.rn-sec span{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:700;color:var(--text-2)}
.rn-sec i{width:4px;height:12px;border-radius:1px;background:var(--text-3);transform:skewX(-18deg)}
.rn-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--text-2)}
.rn-rr:hover .rn-name,.rn-rr.open .rn-name{color:var(--text)}
.rn-rch{text-align:right;font-size:12.5px;color:var(--text-3)}
.rn-bar{position:relative;height:7px}
.rn-bar i{position:absolute;right:2px;top:0;bottom:0;min-width:2px;border-radius:1.5px;transform:skewX(-20deg);background:rgba(255,255,255,.16)}
.rn-bar i.good{background:var(--good)}.rn-bar i.warn{background:var(--warn)}.rn-bar i.loss{background:var(--bad)}
/* Past the scale: a full bar, broken near its far end. */
.rn-bar i.over{-webkit-mask:linear-gradient(90deg,#000 5px,transparent 5px 9px,#000 9px);mask:linear-gradient(90deg,#000 5px,transparent 5px 9px,#000 9px)}
.rn-hero{text-align:right;font-size:15px;font-weight:700;white-space:nowrap}
.rn-hero.good{color:var(--good)}.rn-hero.warn{color:var(--warn)}.rn-hero.loss{color:var(--bad)}
.rn-hero.muted{font-size:12px;font-weight:400;color:var(--text-3)}
.rn-more{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:7px;background:none;color:var(--text-3)}
.rn-more:hover,.rn-more[aria-expanded=true]{background:rgba(255,255,255,.08);color:var(--text)}
#runs-panel .rn-more svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;transition:transform .15s}
.rn-more[aria-expanded=true] svg{transform:rotate(180deg)}
/* An open ramp: You, the reference and the difference, aligned as figures; only the difference is graded. */
.rn-detail{margin:0 0 6px;border-radius:0 0 8px 8px;background:rgba(255,255,255,.045)}
.rn-detail-in{padding:2px 12px 10px 8px}
.rn-x{display:grid;grid-template-columns:minmax(78px,max-content) repeat(3,66px);column-gap:14px;width:max-content;font-size:12.5px;line-height:1.3}
.rn-x.solo{grid-template-columns:minmax(78px,max-content) 66px}
.rn-xr{display:contents}
.rn-xr>*{padding:3px 0;text-align:right;white-space:nowrap}
.rn-xr>:first-child{text-align:left;color:var(--text-2)}
.rn-xr.sub>:first-child{padding-left:12px;color:var(--text-3)}
.rn-xr>b{font-weight:700;color:var(--text)}
.rn-xr>span:nth-child(3){color:var(--text-2)}
.rn-xr>b.good{color:var(--good)}.rn-xr>b.warn{color:var(--warn)}.rn-xr>b.loss{color:var(--bad)}.rn-xr>b.muted{color:var(--text-3)}
.rn-xh>*{padding:6px 0 4px;font-size:11px;font-weight:700;letter-spacing:.07em;color:var(--text-3)!important}
.rn-x-note{margin:8px 0 0;font-size:12px;color:var(--text-3)}
.rn-collect{align-items:center}
.rn-collect .rn-meter{flex:none;padding:0}
.rn-collect .rn-meter i{flex:none;width:9px}

/* Empty and off states: what to do next. */
.rn-empty{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:22px 22px 26px}
.rn-empty b{font-size:17px}
.rn-empty p{margin:0;color:var(--text-2);max-width:44ch}
.rn-cta{margin-top:10px;padding:8px 14px;border:0;border-radius:10px;background:var(--accent);color:var(--on-accent)!important;font-weight:700}
.rn-off{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;margin:2px 12px 8px;padding:8px 8px 8px 12px;border-radius:11px;
  font-size:12.5px;color:var(--warn);background:color-mix(in srgb,var(--warn) 10%,transparent)}
.rn-link{padding:4px 10px;border:0;border-radius:8px;background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)!important;font-size:12.5px;font-weight:700}

@media (max-width:600px){
  #runs-panel,#runs-panel.over-replay{left:12px;right:12px;width:auto;max-width:none}
  .rn-top{grid-template-columns:1fr}
  .rn-stats{grid-template-columns:repeat(4,auto);justify-content:start;gap:12px 22px}
  .rn-stat{align-items:flex-start}
  .rn-pb-time{font-size:42px}
  .rn-row,.rn-cols{grid-template-columns:90px 64px minmax(40px,1fr) 36px 58px 30px;gap:8px}
}
@media (max-width:470px){
  .rn-row,.rn-cols{grid-template-columns:86px 62px minmax(36px,1fr) 52px 30px}
  .rn-start,.rn-cols span:nth-child(4){display:none}
  .rn-rr{grid-template-columns:80px 34px minmax(24px,1fr) 70px 22px;gap:8px}
  .rn-toolbar{gap:6px}.rn-seg button{padding:5px 9px}
  .rn-x{grid-template-columns:minmax(70px,max-content) repeat(3,58px);column-gap:10px}
  .rn-x.solo{grid-template-columns:minmax(70px,max-content) 58px}
}
@media (prefers-reduced-motion:reduce){#runs-panel{animation:none}.rn-watch[aria-busy=true]::after{animation-duration:2s}}

/* History page (in the settings panel): the rule as a sentence, storage as a bar. */
/* The History tab's preview fills the HUD preview's slot, drawn the HUD's way:
   rose for your best finish, paper bars for the newest runs, short resets faded out. */
.history-preview{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;
  color:var(--paper);-webkit-text-stroke:1.25px rgba(8,8,8,.72);paint-order:stroke fill;text-shadow:0 1px 2px rgba(0,0,0,.5);font-variant-numeric:tabular-nums}
.hp{display:flex;align-items:flex-end;gap:22px}
.hp.off{opacity:.4}
.hp-group{display:flex;flex-direction:column;align-items:center;gap:8px}
.hp-bars{display:flex;align-items:flex-end;gap:4px;height:36px}
.hp-bars i{width:5px;border-radius:1px;transform:skewX(-18deg);background:var(--paper);box-shadow:0 0 0 1.25px rgba(8,8,8,.7)}
.hp-bars i.best{width:7px;background:var(--accent)}
.hp-bars i.latest{width:7px;background:none;box-shadow:inset 0 0 0 1.75px var(--accent),0 0 0 1.25px rgba(8,8,8,.7)}
.hp-bars i.skip{height:7px;opacity:.3}
.hp-bars b{align-self:center;margin-left:5px;font-size:12px}
.hp-group span{font-size:11px;font-weight:700;letter-spacing:.07em;opacity:.85}
.hp-note{margin:0;font-size:11px;font-weight:700;letter-spacing:.05em;opacity:.6}
@media (max-height:720px){.hp-bars{height:28px}.hp-bars i{max-height:28px}}
@media (max-height:640px){.hp-note{display:none}.hp-bars{height:22px}.hp-bars i{max-height:22px}.hp-group{gap:5px}}

/* Zen: a pill like Runs and QoL; on, it turns rose. */
.launcher.zen{gap:8px;padding:0 15px 0 13px}
.zen-mark{flex:none;width:12px;height:12px;border-radius:50%;box-shadow:inset 0 0 0 1.75px var(--text-2)}
.launcher.zen[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#141414}
.launcher.zen[aria-pressed=true] .zen-mark{background:#141414;box-shadow:none}
.launcher.zen[aria-pressed=true]:hover{filter:brightness(1.06)}

#page-history .hist-rule{margin:14px 0 2px;padding:12px 14px;border-radius:12px;font-size:13px;line-height:1.5;color:var(--text-2);
  background:color-mix(in srgb,var(--accent) 7%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 14%,transparent)}
#page-history .hist-rule b{color:var(--text)}
#page-history .hist-rule.off{background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px var(--line)}
.hist-store{padding:14px 0 6px}
.hist-total{display:flex;align-items:baseline;gap:10px;font-size:13px;color:var(--text-2)}
.hist-total b{font-size:24px;line-height:1;color:var(--text);font-variant-numeric:tabular-nums}
`;
