const CHANNEL = 'surfd-qol-private-rooms-v1';

// For development: BroadcastChannel reaches only tabs of the same browser. It
// also delivers to this tab, so one page can host and join.
export function createBroadcastSignalling() {
  const channel = new BroadcastChannel(CHANNEL);
  const subscribers = new Set();
  let closed = false;
  const deliver = message => {
    if (closed || !message || typeof message.roomId !== 'string' ||
        typeof message.peerId !== 'string' || typeof message.type !== 'string') return;
    for (const callback of subscribers) callback(message);
  };
  channel.onmessage = event => deliver(event.data);
  return {
    send(message) {
      if (closed) throw new DOMException('Signalling is closed', 'InvalidStateError');
      const copy = structuredClone(message);
      channel.postMessage(message);
      queueMicrotask(() => deliver(copy));
    },
    subscribe(callback) {
      if (closed) throw new DOMException('Signalling is closed', 'InvalidStateError');
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    close() {
      if (closed) return;
      closed = true;
      subscribers.clear();
      channel.onmessage = null;
      channel.close();
    },
  };
}
