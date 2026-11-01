import { instrumentGame, instrumentPhysicsWorker } from './instrument.js';
import { loadGameSource } from './source-loader.js';
import { createUpdateChecker } from './update-check.js';

export const origin = 'https://surfd.net';
export const isSurfd = url => { try { const parsed = new URL(url); return parsed.origin === origin && parsed.pathname === '/'; } catch { return false; } };
export const isGameModule = url => url.startsWith(`${origin}/assets/game-`);
export const WORKERS = ['checkpoint-speed', 'ghost', 'replay-index'];

// text is null when the browser only revalidated its cached copy and the body is unavailable.
export async function patchModule(url, text) {
  const source = await loadGameSource(url, text);
  return isGameModule(url) ? instrumentGame(source) : instrumentPhysicsWorker(source);
}

export async function status(tabId, message, error = false) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'surfd-qol-status', message, error }); } catch { /* navigation */ }
  await chrome.action.setBadgeText({ tabId, text: error ? '!' : 'ON' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: error ? '#b83c42' : '#286a61' }).catch(() => {});
  await chrome.action.setTitle({tabId, title: `Surfd QoL — ${message}`}).catch(() => {});
}

const checkForUpdate = createUpdateChecker({storage: chrome.storage.local, version: chrome.runtime.getManifest().version});

// Returns true when it answered, so the caller's listener can keep the channel open.
export function answerUpdateCheck(message, sender, respond) {
  if (message?.type !== 'surfd-qol-check-update' || !sender.tab || !isSurfd(sender.url)) return false;
  checkForUpdate().then(update => respond({update}), () => respond({update: null}));
  return true;
}
