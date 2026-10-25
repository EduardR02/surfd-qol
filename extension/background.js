import { instrumentGame } from './instrument.js';
import { createUpdateChecker } from './update-check.js';

const sessions = new Map();
const origin = 'https://surfd.net';
const isSurfd = url => { try { const parsed = new URL(url); return parsed.origin === origin && parsed.pathname === '/'; } catch { return false; } };
const command = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
const checkForUpdate = createUpdateChecker({storage: chrome.storage.local, version: chrome.runtime.getManifest().version});

async function status(tabId, message, error = false) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'surfd-qol-status', message, error }); } catch { /* navigation */ }
  await chrome.action.setBadgeText({ tabId, text: error ? '!' : 'ON' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: error ? '#b83c42' : '#286a61' }).catch(() => {});
  await chrome.action.setTitle({tabId, title: `Surfd QoL — ${message}`}).catch(() => {});
}

async function attach(tabId) {
  if (sessions.has(tabId)) return sessions.get(tabId);
  const pending = (async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!isSurfd(tab.url)) throw new Error('Only https://surfd.net is supported.');
    await chrome.debugger.attach({ tabId }, '1.3');
    try {
      await command(tabId, 'Fetch.enable', { patterns: [{ urlPattern: 'https://surfd.net/assets/game-*.js', resourceType: 'Script', requestStage: 'Response' }] });
      // A first visit may already have requested its module before attach completed.
      // Reload only on initial attachment, never once a session is instrumented.
      await chrome.tabs.reload(tabId);
    } catch (error) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      throw error;
    }
    return true;
  })();
  sessions.set(tabId, pending);
  try { return await pending; } catch (error) { sessions.delete(tabId); throw error; }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'surfd-qol-check-update' && sender.tab && isSurfd(sender.url)) {
    checkForUpdate().then(update => respond({update}), () => respond({update: null}));
    return true;
  }
  if (message?.type !== 'surfd-qol-connect' || !sender.tab || !isSurfd(sender.url)) return;
  attach(sender.tab.id).then(() => respond({ ok: true }), async error => {
    await status(sender.tab.id, `Could not attach: ${error.message}. Close DevTools and use the QoL toolbar button to retry.`, true);
    respond({ ok: false, error: error.message });
  });
  return true;
});

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined || method !== 'Fetch.requestPaused') return;
  const { requestId } = params;
  let released = false;
  try {
    if (![200, 304].includes(params.responseStatusCode) || new URL(params.request.url).origin !== origin) return;
    let text;
    if (params.responseStatusCode === 304) {
      // A conditional module request has no response body. Fetch just this
      // public asset afresh; do not disable caching for maps/textures/audio.
      const fresh = await fetch(params.request.url, { cache: 'no-store', credentials: 'omit' });
      if (!fresh.ok) throw new Error(`Could not read game module: HTTP ${fresh.status}`);
      text = await fresh.text();
    } else {
      const response = await command(tabId, 'Fetch.getResponseBody', { requestId });
      text = response.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(response.body), c => c.charCodeAt(0))) : response.body;
    }
    const patched = instrumentGame(text);
    const bytes = new TextEncoder().encode(patched);
    // Modules are ASCII in current builds; conversion also handles future UTF-8 assets.
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    const responseHeaders = (params.responseHeaders ?? []).filter(header => !['content-length', 'content-encoding', 'content-type', 'transfer-encoding', 'etag', 'content-md5', 'digest'].includes(header.name.toLowerCase()));
    responseHeaders.push({ name: 'Content-Type', value: 'text/javascript; charset=utf-8' });
    await command(tabId, 'Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders, body: btoa(binary) });
    released = true;
    await status(tabId, 'Tick observer connected.');
  } catch (error) {
    await status(tabId, `${error.message}. Game left unmodified; feedback unavailable.`, true);
  } finally {
    if (!released) await command(tabId, 'Fetch.continueRequest', { requestId }).catch(() => {});
  }
});

chrome.debugger.onDetach.addListener(async ({ tabId }, reason) => {
  if (tabId === undefined) return;
  sessions.delete(tabId);
  let ready = false;
  try { ready = (await chrome.tabs.sendMessage(tabId, {type:'surfd-qol-page-status'}))?.ready === true; } catch { /* closed/navigating page */ }
  await status(tabId, ready
    ? 'Page features active; loader detached. Reconnect with the toolbar button before reloading.'
    : `Setup unavailable: loader detached (${reason}). Use the toolbar button to reconnect.`, !ready);
});
chrome.tabs.onRemoved.addListener(tabId => sessions.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url || isSurfd(change.url) || !sessions.has(tabId)) return;
  sessions.delete(tabId);
  chrome.debugger.detach({ tabId }).catch(() => {});
});
chrome.action.onClicked.addListener(async tab => {
  if (!isSurfd(tab.url)) return;
  try {
    if (sessions.has(tab.id)) await chrome.tabs.reload(tab.id);
    else await attach(tab.id);
  } catch (error) { await status(tab.id, error.message, true); }
});
