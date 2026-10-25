let pageReady = false;
window.addEventListener('surfd-qol-page-state', event => { pageReady = event.detail?.ready === true; });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'surfd-qol-page-status') {
    window.dispatchEvent(new Event('surfd-qol-query-state'));
    respond({ready: pageReady});
    return;
  }
  if (message?.type !== 'surfd-qol-status') return;
  // JSON avoids sharing privileged extension objects with the page world.
  window.dispatchEvent(new CustomEvent('surfd-qol-status', { detail: JSON.parse(JSON.stringify({ message: message.message, error: message.error })) }));
});
window.dispatchEvent(new Event('surfd-qol-query-state'));
if (location.pathname === '/') chrome.runtime.sendMessage({ type: 'surfd-qol-connect' }).catch(error => {
  window.dispatchEvent(new CustomEvent('surfd-qol-status', { detail: { error: true, message: `Extension connection failed: ${error.message}` } }));
});
if (location.pathname === '/') chrome.runtime.sendMessage({type: 'surfd-qol-check-update'}).then(response => {
  if (response?.update) window.dispatchEvent(new CustomEvent('surfd-qol-release', {detail: {version: response.update.version}}));
}).catch(() => { /* Release checks never affect game setup. */ });
