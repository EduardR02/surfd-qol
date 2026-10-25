import { createMetrics } from './metrics.js';
import { createStartFeedback } from './start.js';
import { createRunHistory } from './run-history.js';
import { createReplayArchive, createHistoryStore, createAnalysisStore, openSiteDatabase } from './replay-archive.js';
import { trimReplay } from './replay-trim.js';
import { createReplayControl } from './replay-control.js';
import { createReferenceReplayStore } from './replay-store.js';
import { createRampReference } from './ramp-reference.js';
import { observePhysics } from './observer.js';
import { createBindings } from './bindings.js';
import { mountHud } from './hud.js';
import { applySettings as applySettingsTo, colorKeys, defaults, storageKey, storageLimitKeys } from './settings.js';

const settings = { ...defaults };
const applySettings = patch => applySettingsTo(settings, patch);
try { applySettings(JSON.parse(localStorage.getItem(storageKey) ?? '{}')); } catch { /* storage unavailable */ }

const metrics = createMetrics(settings);
const start = createStartFeedback();
const database = openSiteDatabase();
const replays = createReplayArchive({ database });
const history = createRunHistory({
  metrics, start, archive: replays,
  getState: () => window.__SURF__?.snapshot?.() ?? null,
  getMap: () => api.adapter?.getSession()?.map ?? null,
  getMapName: () => api.adapter?.getReferences?.()?.mapName ?? null,
  // The replay is trimmed to a few seconds before the start when the game's
  // own simulation confirms the trimmed one reaches the same start.
  onReplay: (run, replay, clip) => {
    return replays.save(run, replay, clip ? () => trimReplay(api.adapter?.Session, replay, clip) : null)
      .then(saved => {
        if (!saved) history.setReplayUnavailable(run.id);
        else if (saved.offset) history.setReplayOffset(run.id, saved.offset);
      }, error => {
        history.setReplayUnavailable(run.id);
        console.warn('[Surfd QoL] Could not save replay:', error);
      });
  },
  limits: () => ({ runsPerMap: settings.historyRunsPerMap, minSeconds: settings.historyMinSeconds }),
  // Also runs once the saved history has loaded, dropping replays left over
  // from runs that are no longer kept.
  onPrune: ids => { replays.retain(ids); },
  store: createHistoryStore(database)
});
// PB/WR replays are re-simulated once, saved across visits, and shared by the
// HUD's comparisons, the Runs panel's ramps and the replay timeline's colours.
const replayStore = createReferenceReplayStore({ getAdapter: () => api.adapter, saved: createAnalysisStore(database) });
const rampReference = createRampReference({
  getSession: () => api.adapter?.getSession() ?? null, getReferences: () => api.adapter?.getReferences() ?? null,
  getAdapter: () => api.adapter, replayStore, settings
});
const replayControl = createReplayControl({
  getAdapter: () => api.adapter, getSession: () => api.adapter?.getSession() ?? null, archive: replays,
  settings,
  getMapName: () => api.adapter?.getReferences?.()?.mapName ?? null,
  getRun: id => history.run(id),
  onSpots: (runId, spots) => history.setSpots(runId, spots),
  grade: rampReference.createConsumer(),
  coaching: {
    save: () => ({metrics: metrics.saveState(), start: start.saveState()}),
    restore: state => { metrics.restoreState(state.metrics); start.restoreState(state.start); },
    reset: tick => { metrics.reset({replayGap: tick > 0}); start.reset(); }
  },
  rampNumber: (mapKey, rampKey) => history.rampNumber(mapKey, rampKey),
  // Explains that replay locs become practice savelocs until you've saved one.
  teach: {
    due: () => { try { return localStorage.getItem(`${storageKey}-replay-locs`) !== '1'; } catch { return true; } },
    done: () => { try { localStorage.setItem(`${storageKey}-replay-locs`, '1'); } catch { /* shown again next time */ } }
  }
});
let observer = null;
let hud = null;
let availableUpdate = null;
let runtimeStatus = 'Connecting physics observer…';
let failed = false;
let destroyed = false;
const bindings = createBindings(() => api.adapter, settings, onSettings);
function onSettings(patch) {
  const startWasShown = settings.hud !== false && settings.showStart !== false;
  applySettings(patch);
  if (startWasShown && (settings.hud === false || settings.showStart === false)) start.reset();
  replayControl.settingsChanged();
  try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* private/storage-limited mode */ }
  if (Object.keys(patch ?? {}).some(key => storageLimitKeys.includes(key))) history.prune();
  if (patch?.keepHistory === false) history.discard();
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
    if (destroyed || api.adapter) return;
    try {
      observer = observePhysics(adapter, metrics, {
        onBeforeTick(session) { replayControl.observe(session); },
        onTick(session, command, events) {
          // The Start flash costs nothing while hidden; a stale flash ages out.
          if (settings.hud !== false && settings.showStart !== false) start.observe(session, events);
          // Recording off costs nothing per tick.
          if (settings.keepHistory !== false) history.observe(session, events);
          if (events.includes('finish')) hud?.observeFinish();
          replayControl.tick(session);
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
    if (destroyed) return;
    destroyed = true;
    clearInterval(bindingTimer);
    for (const type of SIDE_BUTTON_EVENTS) window.removeEventListener(type, keepSideButtons, true);
    bindings.release();
    // Remove the replay restore wrapper before the observer it wraps.
    replayControl.destroy();
    observer?.destroy();
    hud?.destroy();
    rampReference.destroy();
    document.removeEventListener('DOMContentLoaded', mount);
    window.removeEventListener('surfd-qol-release', receiveRelease);
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
function receiveRelease(event) {
  availableUpdate = {version: event.detail?.version};
  hud?.setUpdate(availableUpdate);
}
window.addEventListener('surfd-qol-release', receiveRelease);
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
  if (destroyed || location.pathname !== '/') return;
  hud = mountHud({
    getState: () => window.__SURF__?.snapshot() ?? null,
    getView: api.getView,
    getMetrics: api.getMetrics,
    getSession: () => api.adapter?.getSession() ?? null,
    getReferences: () => api.adapter?.getReferences() ?? null,
    getAdapter: () => api.adapter,
    settings, onSettings, bindings, history, replays, replayControl, rampReference,
    services: { replayStore },
    onResetColors: () => onSettings(Object.fromEntries(colorKeys.map(key => [key, defaults[key]])))
  });
  hud.setUpdate(availableUpdate);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
