// Short-lived credentials for Cloudflare's TURN relay, which carries all room
// traffic so that no player ever sees another's IP address. Kept apart from
// the Workers runtime so it can be tested anywhere; worker.js passes the env.

// Renew before an hour ends instead of leaving reusable credentials alive for four.
export const RELAY_TTL = 60 * 60;
export const RELAY_TIMEOUT_MS = 5000;
const API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

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

// Every provider request needs both the per-client allowance and a committed
// global reservation. Its issuance deadline bounds the reservation's lifetime.
// Failures deliberately burn reservations; no provider answers or secrets log.
export function createRelay({env, allow, reserve, fetch = (...args) => globalThis.fetch(...args), now = () => Date.now()}) {
  return async client => {
    try {
      if (env?.RELAY !== 'on' || !env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN || !allow(client)) return null;
      const reservation = await reserve();
      if (!Number.isSafeInteger(reservation?.issueBy)) return null;
      const remaining = Math.min(RELAY_TIMEOUT_MS, reservation.issueBy - now());
      if (remaining <= 0) return null;
      const response = await fetch(`${API}/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({ttl: RELAY_TTL}),
        signal: AbortSignal.timeout(remaining),
      });
      if (!response.ok || now() >= reservation.issueBy) return null;
      const iceServers = turnServers(await response.json());
      return iceServers.length ? {iceServers, ttl: RELAY_TTL} : null;
    } catch {
      return null;
    }
  };
}
