// Worker-shaped leases let the native player keep its validation, watchdog and
// fallback. Only the map's worker/world outlives stopWorker(); indexes do not.
export function createReplayIndexPool(prepare) {
  let slot = null, rendererScope = null, generation = 0;
  const protocol = 1;
  function evict(owner = slot) {
    if (!owner) return;
    if (slot === owner) slot = null;
    owner.worker.onmessage = owner.worker.onerror = owner.worker.onmessageerror = null;
    owner.worker.terminate();
    const lease = owner.lease;
    if (lease && !lease.closed) {
      lease.onclose?.();
      lease.closed = true;
    }
  }
  function fail(owner, event) {
    const lease = owner.lease, notify = lease && !lease.closed;
    evict(owner);
    if (notify) lease.onerror?.(event ?? {preventDefault() {}});
  }
  function current(owner, lease) {
    return slot === owner && owner.lease === lease && !lease.closed;
  }
  async function post(owner, lease) {
    if (!owner.ready || !lease.message || lease.posting) return;
    lease.posting = true;
    const isCurrent = () => current(owner, lease);
    try {
      let packet = null;
      if (!owner.world) {
        try { packet = await prepare(lease.map, lease.session, lease.message, isCurrent); }
        catch { /* Native geometry loading remains the cold-path fallback. */ }
      }
      if (!isCurrent()) return;
      const message = {...lease.message, __surfdQolIndex: protocol, type: 'run', job: lease.id};
      const transfer = [];
      if (packet) {
        message.__surfdQolCollision = packet;
        for (const value of Object.values(packet)) {
          if (ArrayBuffer.isView(value) && !transfer.includes(value.buffer)) transfer.push(value.buffer);
        }
      }
      lease.dispatched = true;
      try { owner.worker.postMessage(message, transfer); }
      catch (error) {
        if (!packet) throw error;
        delete message.__surfdQolCollision;
        owner.worker.postMessage(message);
      }
    } catch {
      if (isCurrent()) fail(owner);
    }
  }
  return {
    acquire(map, replay, session, createWorker) {
      if (slot && (slot.scope !== rendererScope || slot.mapId !== replay.mapId || slot.version !== replay.mapVersion)) evict();
      slot?.lease?.terminate();
      if (!slot) {
        const owner = {worker: createWorker(), scope: rendererScope, mapId: replay.mapId, version: replay.mapVersion,
          ready: false, world: false, lease: null};
        slot = owner;
        owner.worker.onmessage = event => {
          if (slot !== owner) return;
          const data = event.data;
          // An unpatched native worker rejects hello. Never run it as though it
          // supported retained worlds, generation routing or cancellation.
          if (data?.__surfdQolIndex !== protocol) { fail(owner); return; }
          if (data.type === 'ready') {
            owner.ready = true;
            if (owner.lease) void post(owner, owner.lease);
            return;
          }
          const lease = owner.lease;
          if (!lease || !current(owner, lease) || data.job !== lease.id) return;
          if (data.type === 'world') {
            if (data.mapId !== owner.mapId || data.mapVersion !== owner.version) { fail(owner); return; }
            owner.world = true;
          } else if (data.type === 'batch' && data.ok === true) {
            lease.onmessage?.({data});
          } else {
            fail(owner);
          }
        };
        owner.worker.onerror = event => { event.preventDefault?.(); fail(owner, event); };
        owner.worker.onmessageerror = () => fail(owner);
      }
      const owner = slot;
      const lease = {
        id: ++generation, map, session, closed: false, posting: false, dispatched: false, message: null,
        onmessage: null, onerror: null, onclose: null,
        postMessage(message) {
          if (!current(owner, lease)) return;
          lease.message = message;
          void post(owner, lease);
        },
        terminate(failed = false) {
          if (lease.closed) return;
          lease.closed = true;
          if (!currentOwner()) return;
          owner.lease = null;
          if (failed || lease.dispatched && !owner.world) { evict(owner); return; }
          try { owner.worker.postMessage({__surfdQolIndex: protocol, type: 'cancel', job: lease.id}); }
          catch { evict(owner); }
        },
      };
      function currentOwner() { return slot === owner && owner.lease === lease; }
      owner.lease = lease;
      if (!owner.ready) {
        try { owner.worker.postMessage({__surfdQolIndex: protocol, type: 'hello'}); }
        catch { evict(owner); throw new Error('Replay worker initialization failed'); }
      }
      return lease;
    },
    ownRenderer(renderer) {
      const scope = {};
      rendererScope = scope;
      evict();
      const dispose = renderer.dispose;
      renderer.dispose = function (...args) {
        if (slot?.scope === scope) evict();
        if (rendererScope === scope) rendererScope = null;
        return dispose.apply(this, args);
      };
    },
  };
}

// One active native simulation, with at most the newest pending request. The
// only scheduled task is a yield between active native indexing chunks.
export function createReplayIndexWorker(post, run, pause = () => new Promise(resolve => setTimeout(resolve, 0))) {
  let active = null, pending = null, running = false;
  const protocol = 1;
  async function drain() {
    running = true;
    while (pending) {
      const message = pending;
      pending = null;
      const job = {id: message.job};
      active = job;
      const current = () => active === job;
      const emit = (data, options) => {
        if (current()) post({...data, __surfdQolIndex: protocol, type: 'batch', job: job.id}, options);
      };
      try {
        await run(message, {
          current, emit, pause,
          world(map) {
            if (current()) post({__surfdQolIndex: protocol, type: 'world', job: job.id,
              mapId: map.id, mapVersion: map.version});
          },
        });
      } catch (error) {
        emit({ok: false, error: error instanceof Error ? error.message : String(error)});
      }
      if (current()) active = null;
    }
    running = false;
  }
  return message => {
    if (message?.__surfdQolIndex !== protocol) {
      post({ok: false, error: 'Replay index worker protocol unavailable'});
      return;
    }
    if (message.type === 'hello') {
      post({__surfdQolIndex: protocol, type: 'ready'});
    } else if (message.type === 'cancel') {
      if (active?.id === message.job) active = null;
      if (pending?.job === message.job) pending = null;
    } else if (message.type === 'run' && Number.isSafeInteger(message.job)) {
      active = null;
      pending = message;
      if (!running) void drain();
    }
  };
}
