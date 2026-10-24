import { createMetrics } from './metrics.js';
import { createStartFeedback } from './start.js';
import { observePhysics } from './observer.js';
import { createBindings } from './bindings.js';
import { mountHud } from './hud.js';

const storageKey = 'surfd-qol.settings.v1';
const defaults = {
  hud: true, scale: 1, y: 82, speedColor: '#ebbcba', opacity: 0.9,
  speedFps: 60, timerFps: 30,
  goodColor: '#9ccfd8', warnColor: '#f6c177', badColor: '#eb6f92',
  showSync: true, showBoard: true, showAir: true, showStart: true, showSurf: true,
  checkpointReference: 'both', wrSource: 'ksf', continuousFeedback: false, airMetric: 'combined',
  boardColorReference: 'fixed', startColorReference: 'fixed', surfColorReference: 'wr',
  startHeightAmazing: 7.5, startHeightGood: 15,
  startDeficitAmazing: 10, startDeficitGood: 17.5, strafeLookbackSeconds: 0.2,
  boardLossAmazing: 5, boardLossGood: 20, airLossAmazing: 5, airLossGood: 20,
  referenceLossTolerance: 2,
  crouchJump: true, crouchJumpKey: 'Space',
  nullAD: false, nullWSpace: false,
};
const colorKeys = ['speedColor', 'goodColor', 'warnColor', 'badColor'];
const settings = { ...defaults };
function applySettings(patch) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in defaults) || typeof value !== typeof defaults[key]) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    settings[key] = value;
  }
  settings.y = Math.max(10, Math.min(90, settings.y));
  settings.scale = Math.max(0.6, Math.min(1.6, settings.scale));
  settings.opacity = Math.max(0.25, Math.min(1, settings.opacity));
  settings.speedFps = Math.round(Math.max(1, Math.min(1000, settings.speedFps)));
  settings.timerFps = Math.round(Math.max(1, Math.min(1000, settings.timerFps)));
  settings.startHeightAmazing = Math.max(0, settings.startHeightAmazing);
  settings.startHeightGood = Math.max(settings.startHeightAmazing, Math.max(0, settings.startHeightGood));
  settings.startDeficitAmazing = Math.max(0, settings.startDeficitAmazing);
  settings.startDeficitGood = Math.max(settings.startDeficitAmazing, Math.max(0, settings.startDeficitGood));
  settings.boardLossAmazing = Math.max(0, settings.boardLossAmazing);
  settings.boardLossGood = Math.max(settings.boardLossAmazing, settings.boardLossGood);
  settings.airLossAmazing = Math.max(0, settings.airLossAmazing);
  settings.airLossGood = Math.max(settings.airLossAmazing, settings.airLossGood);
  settings.referenceLossTolerance = Math.max(0, settings.referenceLossTolerance);
  settings.strafeLookbackSeconds = Math.max(0.05, Math.min(0.5, settings.strafeLookbackSeconds));
  for (const key of colorKeys) if (!/^#[a-f\d]{6}$/i.test(settings[key])) settings[key] = defaults[key];
  if (!['pb', 'wr', 'both'].includes(settings.checkpointReference)) settings.checkpointReference = 'both';
  if (!['ksf', 'leaderboard'].includes(settings.wrSource)) settings.wrSource = 'ksf';
  if (!['missed', 'braking', 'combined'].includes(settings.airMetric)) settings.airMetric = defaults.airMetric;
  if (!['fixed', 'pb', 'wr'].includes(settings.boardColorReference)) settings.boardColorReference = defaults.boardColorReference;
  if (!['fixed', 'pb', 'wr'].includes(settings.startColorReference)) settings.startColorReference = defaults.startColorReference;
  if (!['fixed', 'pb', 'wr'].includes(settings.surfColorReference)) settings.surfColorReference = defaults.surfColorReference;
}
try { applySettings(JSON.parse(localStorage.getItem(storageKey) ?? '{}')); } catch { /* storage unavailable */ }

const metrics = createMetrics(settings);
const start = createStartFeedback();
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
          start.observe(session, events);
          if (events.includes('finish')) hud?.observeFinish();
        },
        onReset() { start.reset(); },
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
    settings, onSettings, bindings,
    onResetColors: () => onSettings(Object.fromEntries(colorKeys.map(key => [key, defaults[key]])))
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
