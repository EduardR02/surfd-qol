// The singleton Lobby owns this record, separate from its room listings.
// Reservations survive disconnects, failed provider requests and object restarts.
import {RELAY_TTL, RELAY_TIMEOUT_MS} from './relay.js';

export const RELAY_BUDGET_KEY = 'relay-budget';
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;

function positiveInteger(value) {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

// No defaults: a missing or malformed deployment limit disables issuance.
export async function reserveRelay(storage, env, now = () => Date.now()) {
  const hourly = positiveInteger(env?.RELAY_GRANTS_PER_HOUR);
  const daily = positiveInteger(env?.RELAY_GRANTS_PER_DAY);
  const unexpired = positiveInteger(env?.RELAY_MAX_UNEXPIRED);
  if (env?.RELAY !== 'on' || !hourly || !daily || !unexpired) return null;
  try {
    return await storage.transaction(async transaction => {
      const record = await transaction.get(RELAY_BUDGET_KEY);
      const at = now(), issueBy = at + RELAY_TIMEOUT_MS, expires = issueBy + RELAY_TTL * 1000;
      if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(expires)) return null;
      if (record !== undefined && (record?.version !== 1 || !Array.isArray(record.grants))) return null;
      const grants = [];
      let recent = 0, today = 0, active = 0;
      for (const grant of record?.grants ?? []) {
        if (!Number.isSafeInteger(grant?.at) || grant.at < 0 || grant.at > at
          || !Number.isSafeInteger(grant.expires) || grant.expires <= grant.at) return null;
        if (grant.at > at - HOUR) recent++;
        if (grant.expires > at) active++;
        if (grant.at > at - DAY) today++;
        if (grant.at > at - DAY || grant.expires > at) grants.push(grant);
      }
      if (recent >= hourly || today >= daily || active >= unexpired) return null;
      grants.push({at, expires});
      await transaction.put(RELAY_BUDGET_KEY, {version: 1, grants});
      return {issueBy};
    });
  } catch {
    // Storage errors never turn a paid provider request into an uncounted one.
    return null;
  }
}
