import { origin, isSurfd, isGameModule, WORKERS, patchModule, status, answerUpdateCheck } from './background-common.js';

const sessions = new Map();
const command = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

async function attach(tabId) {
  if (sessions.has(tabId)) return sessions.get(tabId);
  const pending = (async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!isSurfd(tab.url)) throw new Error('Only https://surfd.net is supported.');
    await chrome.debugger.attach({ tabId }, '1.3');
    try {
      await command(tabId, 'Fetch.enable', { patterns: [
        { urlPattern: 'https://surfd.net/assets/game-*.js', resourceType: 'Script', requestStage: 'Response' },
        // Dedicated-worker entry scripts report as Other on current Chromium.
        ...WORKERS.map(name => ({
          urlPattern: `https://surfd.net/assets/${name}.worker-*.js`, requestStage: 'Response'
        }))
      ] });
      // The game module may have been requested before attach completed; reload so it passes through Fetch.
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
  if (answerUpdateCheck(message, sender, respond)) return true;
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
  const isGame = isGameModule(params.request.url);
  let released = false;
  try {
    if (![200, 304].includes(params.responseStatusCode) || new URL(params.request.url).origin !== origin) return;
    let text = null;
    if (params.responseStatusCode !== 304) {
      const response = await command(tabId, 'Fetch.getResponseBody', { requestId });
      text = response.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(response.body), c => c.charCodeAt(0))) : response.body;
    }
    const patched = await patchModule(params.request.url, text);
    const bytes = new TextEncoder().encode(patched);
    // Modules are ASCII in current builds; conversion also handles future UTF-8 assets.
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    const responseHeaders = (params.responseHeaders ?? []).filter(header => !['content-length', 'content-encoding', 'content-type', 'transfer-encoding', 'etag', 'content-md5', 'digest'].includes(header.name.toLowerCase()));
    responseHeaders.push({ name: 'Content-Type', value: 'text/javascript; charset=utf-8' });
    await command(tabId, 'Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders, body: btoa(binary) });
    released = true;
    if (isGame) await status(tabId, 'Tick observer connected.');
  } catch (error) {
    if (isGame) await status(tabId, `${error.message}. Game left unmodified; feedback unavailable.`, true);
    else console.warn('[Surfd QoL] Native worker optimization unavailable:', error.message);
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
