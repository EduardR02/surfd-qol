let pageReady = false;
// Firefox hides objects made here from page scripts unless they are cloned into the page.
const toPage = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail: typeof cloneInto === 'function' ? cloneInto(detail, window) : detail }));
window.addEventListener('surfd-qol-page-state', event => { pageReady = event.detail?.ready === true; });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'surfd-qol-page-status') {
    window.dispatchEvent(new Event('surfd-qol-query-state'));
    respond({ready: pageReady});
    return;
  }
  if (message?.type !== 'surfd-qol-status') return;
  // JSON avoids sharing privileged extension objects with the page world.
  toPage('surfd-qol-status', JSON.parse(JSON.stringify({ message: message.message, error: message.error })));
});
window.dispatchEvent(new Event('surfd-qol-query-state'));
if (location.pathname === '/') chrome.runtime.sendMessage({ type: 'surfd-qol-connect' }).catch(error => {
  toPage('surfd-qol-status', { error: true, message: `Extension connection failed: ${error.message}` });
});
if (location.pathname === '/') chrome.runtime.sendMessage({type: 'surfd-qol-check-update'}).then(response => {
  if (response?.update) toPage('surfd-qol-release', {version: response.update.version});
}).catch(() => { /* Release checks never affect game setup. */ });
