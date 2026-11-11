import {TOUCH_STORAGE_KEY} from '../extension/touch-history.js';

const CHANNEL = 'surfd-qol-touch-storage';
const idle = () => new Promise(resolve => typeof requestIdleCallback === 'function'
  ? requestIdleCallback(resolve, {timeout: 2000}) : setTimeout(resolve, 0));

// Chrome's extension service worker owns IndexedDB. The page sends one small
// attempt at a time; loading statistics requests only the selected map.
export function createTouchStorageClient({events = window, origin = location.origin,
  legacyStorage = () => localStorage, waitForIdle = idle} = {}) {
  const pending = new Map(), token = crypto.randomUUID();
  let sequence = 0, destroyed = false;
  function receive(event) {
    const message = event.data;
    if (event.source !== events || event.origin !== origin || message?.channel !== CHANNEL ||
      message.direction !== 'response' || message.token !== token) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
  }
  events.addEventListener('message', receive);
  function request(action, data) {
    if (destroyed) return Promise.reject(new Error('Touch storage client closed'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Touch storage worker did not respond'));
      }, 30000);
      pending.set(id, {resolve, reject, timer});
      try { events.postMessage({channel: CHANNEL, direction: 'request', token, id, action, ...data}, origin); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  const ready = (async () => {
    await waitForIdle();
    if (destroyed) return;
    // localStorage is accessible only on the page. Read/delete once while idle;
    // parsing, validation, retention and the atomic import run in the worker.
    const storage = legacyStorage(), legacy = storage?.getItem(TOUCH_STORAGE_KEY);
    if (legacy == null) return;
    if (await request('migrate', {legacy}) !== true) throw new Error('Touch history migration did not commit');
    if (storage.getItem(TOUCH_STORAGE_KEY) === legacy) storage.removeItem(TOUCH_STORAGE_KEY);
  })().catch(error => { if (!destroyed) console.warn('[Surfd QoL] Touch history migration deferred:', error); });
  return {
    ready,
    async load(map) { await ready; return request('load', {map}); },
    async append(run) { await ready; return request('append', {run}); },
    destroy() {
      destroyed = true;
      events.removeEventListener('message', receive);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Touch storage client closed'));
      }
      pending.clear();
    },
  };
}
