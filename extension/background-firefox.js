import { origin, isSurfd, isGameModule, WORKERS, patchModule, status, answerUpdateCheck } from './background-common.js';

// Firefox has no debugger API, but it can rewrite a response body as it
// arrives. The listener is registered on every load, so there is nothing to
// attach, no reload and no debugging bar.
const urls = [`${origin}/assets/game-*.js`, ...WORKERS.map(name => `${origin}/assets/${name}.worker-*.js`)];

browser.webRequest.onHeadersReceived.addListener(details => {
  if (details.statusCode !== 200) return;
  const isGame = isGameModule(details.url);
  const filter = browser.webRequest.filterResponseData(details.requestId);
  const chunks = [];
  filter.ondata = event => chunks.push(event.data);
  filter.onstop = async () => {
    const original = await new Blob(chunks).arrayBuffer();
    try {
      filter.write(new TextEncoder().encode(await patchModule(details.url, new TextDecoder().decode(original))));
      if (isGame) await status(details.tabId, 'Tick observer connected.');
    } catch (error) {
      filter.write(original);
      if (isGame) await status(details.tabId, `${error.message}. Game left unmodified; feedback unavailable.`, true);
      else console.warn('[Surfd QoL] Native worker optimization unavailable:', error.message);
    } finally {
      filter.close();
    }
  };
  filter.onerror = () => { if (isGame) status(details.tabId, `Could not read the game module: ${filter.error}`, true); };
  // The patched body is longer than the one the server measured.
  return { responseHeaders: details.responseHeaders.filter(header => !['content-length', 'etag', 'content-md5', 'digest'].includes(header.name.toLowerCase())) };
}, { urls }, ['blocking', 'responseHeaders']);

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (answerUpdateCheck(message, sender, respond)) return true;
  // The page asks to connect on every load; patching already happened as its scripts arrived.
  if (message?.type === 'surfd-qol-connect' && sender.tab && isSurfd(sender.url)) respond({ ok: true });
});

chrome.action.onClicked.addListener(tab => { if (isSurfd(tab.url)) chrome.tabs.reload(tab.id); });
