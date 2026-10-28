// Short-lived credentials for Cloudflare's TURN relay, which carries all room
// traffic so that no player ever sees another's IP address. Kept apart from
// the Workers runtime so it can be tested anywhere; worker.js passes the env.

// Long enough for a long session; rooms that outlast it renew before it ends.
export const RELAY_TTL = 4 * 60 * 60;
const API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const TIMEOUT_MS = 5000;

// The TURN servers of Cloudflare's answer. STUN would only find addresses a
// relay-only connection never uses, and browsers block port 53.
export function turnServers(body) {
  const servers = Array.isArray(body?.iceServers) ? body.iceServers : [];
  return servers.flatMap(server => {
    const urls = (Array.isArray(server?.urls) ? server.urls : [server?.urls])
      .filter(url => typeof url === 'string' && /^turns?:/.test(url) && !/:53(\?|$)/.test(url));
    return urls.length && typeof server.username === 'string' && typeof server.credential === 'string'
      ? [{urls, username: server.username, credential: server.credential}] : [];
  });
}

// issue(client) resolves to {iceServers, ttl}, or null when the relay is
// switched off (env.RELAY isn't "on"), allow(client) refuses, or Cloudflare
// doesn't answer as documented. It never throws, so neither the key nor
// Cloudflare's answer can end up in an error log.
export function createRelay({env, allow, fetch = (...args) => globalThis.fetch(...args)}) {
  return async client => {
    if (env?.RELAY !== 'on' || !env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN || !allow(client)) return null;
    try {
      const response = await fetch(`${API}/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({ttl: RELAY_TTL}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const iceServers = turnServers(await response.json());
      return iceServers.length ? {iceServers, ttl: RELAY_TTL} : null;
    } catch {
      return null;
    }
  };
}
