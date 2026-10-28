// Per-client limits, kept in memory: each isolate counts on its own. That
// can't add up to a global limit, but it keeps one client from spending the
// free plan's daily requests or flooding a room by itself.

// New connections and relayed messages per client: a burst at once, then one
// more every `every` ms. A host and a dozen guests on one home network,
// joining and reconnecting, stay well inside both.
export const CONNECTIONS = {burst: 60, every: 30000};
export const MESSAGES = {burst: 2000, every: 1000};

// The client a request comes from: its IPv4 address, or its IPv6 /64, since
// one home network gets a whole /64.
export function clientOf(request) {
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right].slice(0, 4).join(':');
}

// A token bucket per client; true while the client is within its limit.
// It remembers at most `clients` of them, forgetting the least recent.
export function createLimiter({burst, every, clients = 10000, now = () => Date.now()}) {
  const buckets = new Map();
  return client => {
    const time = now(), bucket = buckets.get(client);
    const tokens = bucket ? Math.min(burst, bucket.tokens + (time - bucket.at) / every) : burst;
    buckets.delete(client);
    if (buckets.size >= clients) buckets.delete(buckets.keys().next().value);
    buckets.set(client, {tokens: tokens >= 1 ? tokens - 1 : tokens, at: time});
    return tokens >= 1;
  };
}
