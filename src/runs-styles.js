// Run history popup. Shares the settings panel's glass, header, segments and
// buttons (panel-styles.js); only the stats tiles and tables are its own.
export const runsStyles = `
#runs{width:880px;height:auto;max-height:min(800px,calc(100dvh - var(--above) - 16px))}
.bars{display:inline-flex;align-items:flex-end;gap:2px;height:15px}
.bars i{display:block;width:3px;border-radius:1px;background:var(--accent);transform:skewX(-18deg)}
.bars i:nth-child(1){height:7px}.bars i:nth-child(2){height:11px}.bars i:nth-child(3){height:15px}
#runs .head .seg{margin-left:auto}
#runs .head .seg span{padding:5px 11px;font-size:12.5px}
.runs-context{flex:none;margin:-4px 20px 0;font-size:12.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.tiles{flex:none;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1px;margin:12px 12px 4px;border-radius:12px;overflow:hidden;
  background:var(--line);box-shadow:inset 0 0 0 1px var(--line)}
.tile{display:flex;flex-direction:column;gap:2px;min-width:0;padding:10px 12px 9px;background:var(--sunk)}
.tile-label{font-size:11.5px;font-weight:700;color:var(--text-3)}
.tile-value{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text);white-space:nowrap}
.tile-sub{min-height:1.4em;font-size:11.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.runs-hint{flex:none;margin:6px 20px 0;font-size:12.5px;line-height:1.4;color:var(--text-3)}
.runs-message{flex:none;margin:8px 20px 0;padding:8px 12px;border-radius:9px;background:var(--sunk);font-size:12.5px;color:var(--text)}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.runs-body{padding:4px 12px 12px;overflow-x:auto}
.runs-table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}
.runs-table>thead th{position:sticky;top:0;z-index:1;padding:10px 8px 8px;background:#1f1a1b;text-align:right;font-size:11.5px;font-weight:700;color:var(--text-3);
  border-bottom:1px solid var(--line-2)}
.runs-table>thead th:nth-child(-n+4),.run>td:nth-child(-n+4){text-align:left}
.runs-table>tbody>tr>td{padding:9px 8px;text-align:right;color:var(--text-2);border-top:1px solid var(--line)}
.runs-table .map-col{display:none;max-width:140px;overflow:hidden;text-overflow:ellipsis}
.runs-table.with-map .map-col{display:table-cell}
tr.run{cursor:pointer}
.chevron{display:inline-block;width:6px;height:6px;margin:0 9px 2px 1px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;
  transform:rotate(-45deg);transition:transform .12s}
tr.run.open .chevron{transform:translateY(-1px) rotate(45deg)}
tr.run:hover td,tr.run.open td{background:var(--raise)}
tr.run:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
tr.run .run-time{color:var(--text);font-weight:700}
tr.run.best .run-time{color:var(--accent)}
.dim{color:var(--text-3)}
.pill{display:inline-block;margin-left:7px;padding:0 6px;border:1px solid var(--line-2);border-radius:999px;font-size:10.5px;font-weight:700;color:var(--text-3);vertical-align:1px}
.best-pill{border-color:color-mix(in srgb,var(--accent) 55%,transparent);color:var(--accent)}
.runs-table>tbody>tr>td.watch-cell{padding:5px 4px 5px 8px}
.watch{display:inline-flex;align-items:center;gap:5px;padding:4px 9px 4px 7px;border:1px solid var(--line-2);border-radius:8px;background:transparent;
  font-size:12px;font-weight:700;color:var(--text-2)}
.watch svg{width:11px;height:11px;fill:var(--accent)}
.watch:hover{color:var(--text);border-color:color-mix(in srgb,var(--accent) 60%,transparent)}
.runs-empty{margin:28px 8px;text-align:center;font-size:13px;color:var(--text-3)}

.runs-table>tbody>tr.detail>td{padding:4px 8px 16px;text-align:left;background:var(--raise);border-top:0;white-space:normal}
.facts{display:flex;flex-direction:column;gap:3px;margin:6px 0 14px;padding:0 0 0 12px;list-style:none;border-left:2px solid var(--line-2);font-size:13px;color:var(--text-2)}
.facts b{color:var(--text);font-weight:700}
.detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:28px;align-items:start}
.detail-grid h4{margin:0 0 4px;font-size:12px;font-weight:700;color:var(--text-2)}
.detail-grid h4 span{margin-left:4px;font-weight:400;color:var(--text-3)}
.mini{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
.mini th,.mini td{padding:3px 4px;text-align:right;border:0;background:none}
.mini thead th{font-size:11px;font-weight:400;color:var(--text-3)}
.mini tbody th{text-align:left;font-weight:700;color:var(--text-3);white-space:nowrap}
.mini td{color:var(--text-2)}
.detail-grid .note{margin:4px 0 0}
.good{color:var(--good)!important}.loss{color:var(--bad)!important}.muted{color:var(--text-3)!important}

.runs-foot{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 20px 12px;border-top:1px solid var(--line)}
.ghost.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 60%,transparent)}

@media (max-width:900px){
  #runs{left:12px;right:12px;width:auto;max-width:none}
  .tiles{grid-template-columns:repeat(3,minmax(0,1fr))}
  .tile:nth-child(n+4){display:none}
  .detail-grid{grid-template-columns:minmax(0,1fr)}
  .runs-hint{margin-top:2px}
}
@media (prefers-reduced-motion:reduce){
  .chevron{transition:none}
}
`;
