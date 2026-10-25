// Native transport markup and behavior fixture. The stylesheet is the game's
// actual rt-* CSS; extension extras are mounted separately by the real HUD.
export function mountNativeTransport(control, params) {
  const transport = document.createElement('section');
  transport.id = 'replay-transport'; transport.className = 'replay-transport'; transport.hidden = true;
  transport.setAttribute('aria-label', 'Replay controls');
  transport.innerHTML = `<div class="rt-scrub" role="slider" tabindex="-1" aria-label="Replay position" aria-valuemin="0">
<div class="rt-track"><div class="rt-indexed"></div><div class="rt-played"></div><div class="rt-markers"></div><div class="rt-thumb"></div></div>
<div class="rt-tooltip" hidden><b></b><small></small></div></div>
<div class="rt-row">
<button type="button" data-rt="play" class="rt-play" aria-label="Pause (Space)" title="Pause (Space or K)">Ⅱ</button>
<button type="button" data-rt="back10" title="Back 10 seconds (Shift+← or J)">−10s</button>
<button type="button" data-rt="back5" title="Back 5 seconds (←)">−5s</button>
<button type="button" data-rt="fwd5" title="Forward 5 seconds (→)">+5s</button>
<button type="button" data-rt="fwd10" title="Forward 10 seconds (Shift+→ or L)">+10s</button>
<button type="button" data-rt="prev" class="rt-stage" title="Previous checkpoint (Page Up)">◀<span>CP</span></button>
<button type="button" data-rt="next" class="rt-stage" title="Next checkpoint (Page Down)"><span>CP</span>▶</button>
<span class="rt-time" aria-live="off">0:00 / 0:00</span><span class="rt-status" role="status"></span>
<span class="rt-speed-wrap"><button type="button" data-rt="speed" class="rt-speed" aria-haspopup="menu" aria-expanded="false" title="Playback speed ([ and ])">1×</button>
<span class="rt-speed-menu vgui-window" role="menu" hidden>${[8,4,2,1,.5,.25].map(speed => `<button type="button" role="menuitemradio" data-speed="${speed}">${speed}×</button>`).join('')}</span></span>
<button type="button" data-rt="return" class="button-primary rt-return" hidden>Return to server</button>
<button type="button" data-rt="exit" class="rt-exit" title="Close the replay">Exit replay</button></div>`;
  document.body.append(transport);
  let lastMove = performance.now(), hovering = false, drawn = '';
  const q = selector => transport.querySelector(selector);
  const moved = () => { lastMove = performance.now(); };
  document.addEventListener('pointermove', moved, {capture:true, passive:true});
  transport.addEventListener('pointerenter', () => { hovering = true; });
  transport.addEventListener('pointerleave', () => { hovering = false; });
  transport.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    const action = button.dataset.rt;
    if (button.dataset.speed) { control.setSpeed(Number(button.dataset.speed)); q('.rt-speed-menu').hidden = true; }
    else if (action === 'play') control.toggle();
    else if (action === 'back10') control.skip(-10);
    else if (action === 'back5') control.skip(-5);
    else if (action === 'fwd5') control.skip(5);
    else if (action === 'fwd10') control.skip(10);
    else if (action === 'speed') q('.rt-speed-menu').hidden = !q('.rt-speed-menu').hidden;
    else if (action === 'exit') control.exit();
    else if (action === 'return') control.returnToServer();
    else if (action === 'prev' || action === 'next') {
      const status = control.status(), points = [0, ...status.markers, status.length];
      control.seek(action === 'prev' ? points.filter(tick => tick < status.index - 1).at(-1) ?? 0 : points.find(tick => tick > status.index + 1) ?? status.length);
    }
    moved(); render();
  });
  q('.rt-scrub').addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const rect = q('.rt-track').getBoundingClientRect();
    control.seek((event.clientX - rect.left) / rect.width * control.status().length); render();
  });
  // Fixture native key ownership exercises mode switches without an extension
  // duplicate handler; the real game's document handler is used in production.
  const onKey = event => {
    if (!control.active || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.composedPath().some(node => node?.matches?.('input,textarea,select,#panel,#runs-panel'))) return;
    const code = event.code;
    if (code === 'Space' || code === 'KeyK') { if (!event.repeat) control.toggle(); }
    else if (code === 'ArrowLeft' || code === 'KeyJ') control.skip(event.shiftKey || code === 'KeyJ' ? -10 : -5);
    else if (code === 'ArrowRight' || code === 'KeyL') control.skip(event.shiftKey || code === 'KeyL' ? 10 : 5);
    else if (code === 'Comma' || code === 'Period') control.step(code === 'Comma' ? -1 : 1);
    else if (code === 'BracketLeft') control.slower();
    else if (code === 'BracketRight') control.faster();
    else return;
    event.preventDefault(); moved(); render();
  };
  document.addEventListener('keydown', onKey);
  function render() {
    const status = control.status();
    transport.hidden = !status || !control.visible;
    if (!status) return;
    const idle = status.playing && !hovering && q('.rt-speed-menu').hidden && performance.now() - lastMove > 2500;
    transport.classList.toggle('rt-idle', idle);
    q('.rt-played').style.width = `${status.index / status.length * 100}%`;
    q('.rt-indexed').style.width = `${status.indexed / status.length * 100}%`;
    q('.rt-thumb').style.left = `${status.index / status.length * 100}%`;
    q('.rt-track').style.setProperty('--rt-start', `${status.start / status.length * 100}%`);
    const time = seconds => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5,'0')}`;
    q('.rt-time').textContent = `${time(status.index * status.dt)} / ${time(status.length * status.dt)}`;
    q('.rt-status').textContent = status.complete ? '' : `Indexing ${Math.floor(status.indexed / status.length * 100)}%`;
    q('.rt-speed').textContent = `${status.speed}×`; q('.rt-play').textContent = status.playing ? 'Ⅱ' : '▶';
    q('.rt-return').hidden = !status.parked;
    const markerKey = `${status.start},${status.markers},${status.length}`;
    if (drawn !== markerKey) {
      drawn = markerKey;
      q('.rt-markers').innerHTML = [[status.start,'start'],...status.markers.map(tick => [tick,'cp']),[status.length,'finish']].map(([tick,kind]) => `<i class="rt-marker rt-${kind}" style="left:${tick / status.length * 100}%"></i>`).join('');
    }
  }
  const interval = setInterval(render, 33);
  return {root:transport, render, destroy() { clearInterval(interval); document.removeEventListener('pointermove', moved, true); document.removeEventListener('keydown', onKey); transport.remove(); }};
}
