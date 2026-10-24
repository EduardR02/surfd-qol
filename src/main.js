import { createMetrics } from './metrics.js';
import { createStartFeedback } from './start.js';
import { createRunHistory } from './run-history.js';
import { observePhysics } from './observer.js';
import { createBindings } from './bindings.js';
import { mountHud } from './hud.js';
import { applySettings as applySettingsTo, colorKeys, defaults, storageKey } from './settings.js';

const settings = { ...defaults };
const applySettings = patch => applySettingsTo(settings, patch);
try { applySettings(JSON.parse(localStorage.getItem(storageKey) ?? '{}')); } catch { /* storage unavailable */ }

const metrics = createMetrics(settings);
const start = createStartFeedback();
const history = createRunHistory({
  metrics, start,
  getState: () => window.__SURF__?.snapshot?.() ?? null,
  getMapName: () => api.adapter?.getReferences?.()?.mapName ?? null
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
function mount() {
  if (location.pathname !== '/') return;
  hud = mountHud({
    getState: () => window.__SURF__?.snapshot() ?? null,
    getView: api.getView,
    getMetrics: api.getMetrics,
    getSession: () => api.adapter?.getSession() ?? null,
    getReferences: () => api.adapter?.getReferences() ?? null,
    getAdapter: () => api.adapter,
    settings, onSettings, bindings, history,
    onResetColors: () => onSettings(Object.fromEntries(colorKeys.map(key => [key, defaults[key]])))
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
