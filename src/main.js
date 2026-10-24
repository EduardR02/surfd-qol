import { createMetrics } from './metrics.js';
import { createStartFeedback } from './start.js';
import { createRunHistory } from './run-history.js';
import { createReplayArchive } from './replay-archive.js';
import { createReplayControl } from './replay-control.js';
import { observePhysics } from './observer.js';
import { createBindings } from './bindings.js';
import { mountHud } from './hud.js';
import { applySettings as applySettingsTo, colorKeys, defaults, storageKey } from './settings.js';

const settings = { ...defaults };
const applySettings = patch => applySettingsTo(settings, patch);
try { applySettings(JSON.parse(localStorage.getItem(storageKey) ?? '{}')); } catch { /* storage unavailable */ }

const metrics = createMetrics(settings);
const start = createStartFeedback();
const replays = createReplayArchive();
const history = createRunHistory({
  metrics, start,
  getState: () => window.__SURF__?.snapshot?.() ?? null,
  getMapName: () => api.adapter?.getReferences?.()?.mapName ?? null,
  onReplay: (run, replay) => { replays.save(run, replay); }
});
const replayControl = createReplayControl({
  getAdapter: () => api.adapter, getSession: () => api.adapter?.getSession() ?? null, archive: replays,
  getMapName: () => api.adapter?.getReferences?.()?.mapName ?? null,
  onSpots: (runId, spots) => history.setSpots(runId, spots)
});
let observer = null;
let hud = null;
let runtimeStatus = 'Connecting physics observer…';
let failed = false;
const bindings = createBindings(() => api.adapter, settings, onSettings);
function onSettings(patch) {
  applySettings(patch);
  try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* private/storage-limited mode */ }
  bindings.update();
}
function fail(error) {
  failed = true;
  metrics.reset();
  start.reset();
  runtimeStatus = `Feedback unavailable: ${error.message ?? error}`;
  console.error('[Surfd QoL]', error);
  publishPageState();
}
const api = {
  adapter: null,
  settings,
  attach(adapter) {
    if (api.adapter) return;
    try {
      observer = observePhysics(adapter, metrics, {
        onTick(session, command, events) {
          // The Start flash costs nothing while hidden; a stale flash ages out.
          if (settings.hud !== false && settings.showStart !== false) start.observe(session, events);
          history.observe(session, events);
          if (events.includes('finish')) hud?.observeFinish();
        },
        onReset() { start.reset(); history.reset(); },
        onError: fail
      });
      api.adapter = adapter;
      runtimeStatus = 'Tick observer connected';
      failed = false;
      publishPageState();
      bindings.update();
    } catch (error) { fail(error); }
  },
  getView(snapshot) {
    return api.adapter?.getView?.(snapshot) ?? (snapshot ?? window.__SURF__?.snapshot?.())?.spectator ?? null;
  },
  getMetrics() {
    const snapshot = metrics.snapshot();
    return { ...snapshot, start: start.snapshot(), status: failed || !api.adapter ? runtimeStatus : snapshot.status };
  },
  diagnostics() { return { connected: !!api.adapter, healthy: observer?.healthy ?? false, status: runtimeStatus, crouchJump: bindings.status() }; },
  destroy() {
    clearInterval(bindingTimer);
    for (const type of SIDE_BUTTON_EVENTS) window.removeEventListener(type, keepSideButtons, true);
    bindings.release();
    observer?.destroy();
    hud?.destroy();
    window.removeEventListener('surfd-qol-status', receiveStatus);
    failed = true;
    publishPageState();
    window.removeEventListener('surfd-qol-query-state', publishPageState);
    delete window.__SURFD_QOL__;
  }
};
Object.defineProperty(window, '__SURFD_QOL__', { configurable: true, value: api });
function publishPageState() {
  window.dispatchEvent(new CustomEvent('surfd-qol-page-state', {
    detail: {ready: !!api.adapter && !failed && observer?.healthy === true}
  }));
}
window.addEventListener('surfd-qol-query-state', publishPageState);
function receiveStatus(event) {
  if (api.adapter && !event.detail?.error) return;
  runtimeStatus = event.detail?.message ?? runtimeStatus;
  if (event.detail?.error) { failed = true; metrics.reset(); start.reset(); publishPageState(); }
}
window.addEventListener('surfd-qol-status', receiveStatus);
const bindingTimer = setInterval(() => { try { bindings.update(); } catch (error) { fail(error); } }, 250);
// Chrome treats mouse buttons 3 and 4 as Back and Forward. The game cancels
// that only while the pointer is locked, so a bind on a side button left the
// page from menus and replays. Cancel it whenever that button has a bind; the
// game still receives the press.
const SIDE_BUTTON_EVENTS = ['mousedown', 'mouseup', 'pointerup', 'auxclick'];
function keepSideButtons(event) {
  if (event.button !== 3 && event.button !== 4) return;
  let bound = false;
  try {
    const code = `Mouse${event.button}`;
    bound = Object.values(api.adapter?.getBindings?.() ?? {}).some(codes => Array.isArray(codes) && codes.includes(code));
  } catch { /* bindings unavailable */ }
  if (bound) event.preventDefault();
}
for (const type of SIDE_BUTTON_EVENTS) window.addEventListener(type, keepSideButtons, true);
function mount() {
  if (location.pathname !== '/') return;
  hud = mountHud({
    getState: () => window.__SURF__?.snapshot() ?? null,
    getView: api.getView,
    getMetrics: api.getMetrics,
    getSession: () => api.adapter?.getSession() ?? null,
    getReferences: () => api.adapter?.getReferences() ?? null,
    getAdapter: () => api.adapter,
    settings, onSettings, bindings, history, replays, replayControl,
    onResetColors: () => onSettings(Object.fromEntries(colorKeys.map(key => [key, defaults[key]])))
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
